/**
 * Munshot — Concall Deep Dive · Cloudflare Worker (STEP 10 — GO LIVE)
 * ---------------------------------------------------------------------------
 * Serves the static dashboard from ASSETS and owns /api/*. On-demand pipeline:
 *   client picks a company → POST /api/analyze → (if not cached/in-flight) the Worker
 *   dispatches the GitHub Action → the Action writes the report to KV → the client
 *   polls GET /api/report until it's done and renders it.
 *
 *   GET  /api/universe       → company universe list (public/data/universe.json)
 *   POST /api/analyze        → { status: "done"|"queued"|"running"|"error" }
 *   GET  /api/report?slug=…  → { status, report? }
 *   (anything else)          → env.ASSETS.fetch(request)
 *
 * Bindings (wrangler.jsonc):
 *   ASSETS   static-asset fetcher for ./public.
 *   REPORTS  KV namespace. Keys: report:<slug> (finished report JSON, has meta.generated_at),
 *            status:<slug> ({ state, updated_at, message }). The Action writes both via the
 *            Cloudflare KV REST API; the Worker READS them and writes only status:<slug>="queued".
 * Vars (wrangler.jsonc): GITHUB_REPO ("owner/repo"), GITHUB_BRANCH ("main").
 * Secret (wrangler secret put): GITHUB_TOKEN — fine-grained PAT with Actions read/write.
 *   The token is used ONLY server-side for workflow_dispatch and is never returned in a response.
 * ---------------------------------------------------------------------------
 */

const WORKFLOW_FILE = "fetch-company.yml"; // the Action to dispatch (must accept `company` + `slug`)
const FRESH_DAYS = 14;                      // a report newer than this is served from cache, not re-run
const STALE_STATUS_MS = 15 * 60 * 1000;     // a run is ~1-2 min; a queued/running status older than this
                                            // is presumed stuck (cancelled run, missed error step) and re-dispatchable

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** JSON response with CORS + no-store. */
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS_HEADERS, ...extraHeaders },
  });
}

/** URL-safe slug — identical to public/js/analyze.js and pipeline/lib/util.mjs. */
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "company";
}

/** Read a static asset (absolute path) through ASSETS and parse as JSON. */
async function readAssetJson(env, request, path) {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const res = await env.ASSETS.fetch(new Request(url.toString(), { method: "GET" }));
  if (!res.ok) throw new Error(`asset ${path} → ${res.status}`);
  return res.json();
}

/** Read a KV JSON value, or null if absent/unparseable. */
async function kvJson(env, key) {
  if (!env.REPORTS) return null;
  try { return await env.REPORTS.get(key, { type: "json" }); } catch { return null; }
}

/** Is a stored report newer than FRESH_DAYS? */
function isFresh(report) {
  const g = report && report.meta && report.meta.generated_at;
  const t = g ? Date.parse(g) : NaN;
  return Number.isFinite(t) && Date.now() - t < FRESH_DAYS * 86400000;
}

/** A job the pipeline is (claims to be) actively working on. */
function isInFlight(status) {
  return !!status && (status.state === "queued" || status.state === "running");
}

/** An in-flight status is "stuck" if it hasn't been touched within STALE_STATUS_MS (or has no
 *  timestamp we can trust). Stuck statuses stop blocking a fresh dispatch / poll. */
function isStatusStale(status) {
  const t = status && status.updated_at ? Date.parse(status.updated_at) : NaN;
  return !Number.isFinite(t) || Date.now() - t > STALE_STATUS_MS;
}

/**
 * Dispatch the GitHub Action via workflow_dispatch. Returns nothing on success (HTTP 204);
 * throws a SANITIZED error on failure. The GITHUB_TOKEN lives only in the request header and is
 * never included in the thrown message or any response.
 */
async function dispatchWorkflow(env, inputs) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "munshot-concall-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: env.GITHUB_BRANCH || "main", inputs }),
  });
  if (res.status !== 204) {
    // GitHub echoes the request body (never the auth header), so a short snippet is token-safe.
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`dispatch HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── GET /api/universe ─────────────────────────────────────────────────────────
async function handleUniverse(env, request) {
  return json(await readAssetJson(env, request, "/data/universe.json"));
}

/**
 * POST /api/analyze { company, ticker?, force? }
 *   fresh report (and not forced) → { status: "done" } (client GETs it).
 *   a job already in flight        → return that state (no duplicate dispatch), unless it's stale/forced.
 *   else                           → status:<slug>=queued, dispatch the Action, return "queued".
 *
 * The KV key (slug) is derived SERVER-SIDE from the company — a caller cannot supply a slug that
 * points at another company's cache (that would let one company's report poison another's key).
 */
async function handleAnalyze(env, request) {
  let body = {};
  try { body = (await request.json()) || {}; } catch { /* empty/invalid body */ }
  const company = String(body.company || body.ticker || "").trim();
  const slug = slugify(company); // NOT body.slug — the client cannot choose the KV key
  if (!company || !slug || slug === "company") return json({ ok: false, status: "error", error: "missing company" }, 400);
  const force = body.force === true;

  const [report, status] = await Promise.all([kvJson(env, `report:${slug}`), kvJson(env, `status:${slug}`)]);

  if (report && isFresh(report) && !force) return json({ ok: true, slug, status: "done" });
  // A live run blocks a duplicate dispatch — but a stuck (stale) status, or an explicit force, re-runs.
  if (isInFlight(status) && !isStatusStale(status) && !force) {
    return json({ ok: true, slug, status: status.state, message: status.message });
  }

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return json({ ok: false, status: "error", error: "analysis is not configured on the server" }, 503);
  }
  if (env.REPORTS) await env.REPORTS.put(`status:${slug}`, JSON.stringify({ state: "queued", updated_at: new Date().toISOString(), message: "Dispatching run…" }));
  try {
    await dispatchWorkflow(env, { company, slug });
  } catch (err) {
    if (env.REPORTS) await env.REPORTS.put(`status:${slug}`, JSON.stringify({ state: "error", updated_at: new Date().toISOString(), message: "Could not start the analysis run." }));
    return json({ ok: false, slug, status: "error", error: "could not start analysis", detail: String(err && err.message || err) }, 502);
  }
  return json({ ok: true, slug, status: "queued" });
}

/**
 * GET /api/report?slug=… → { status, report? }.
 * A FRESH in-flight run wins over any stored report, so a refresh/regenerate keeps the client polling
 * for the NEW result instead of instantly re-rendering the old one. Once the run finishes (status no
 * longer in-flight), the report wins. A stuck (stale) in-flight status falls through to serving
 * whatever report we have rather than polling forever. Read-only: the slug param never writes KV.
 */
async function handleReport(env, request, url) {
  const slug = slugify(url.searchParams.get("slug") || "");
  if (!slug || slug === "company") return json({ ok: false, status: "error", error: "missing slug" }, 400);

  const [report, status] = await Promise.all([kvJson(env, `report:${slug}`), kvJson(env, `status:${slug}`)]);
  if (isInFlight(status) && !isStatusStale(status)) return json({ ok: true, slug, status: status.state, message: status.message });
  if (report) return json({ ok: true, slug, status: "done", report });
  if (status && status.state === "error") return json({ ok: false, slug, status: "error", error: status.message || "Analysis failed." });
  return json({ ok: false, slug, status: "unknown" });
}

async function handleApi(env, request, url) {
  try {
    if (url.pathname === "/api/universe" && request.method === "GET") return await handleUniverse(env, request);
    if (url.pathname === "/api/analyze" && request.method === "POST") return await handleAnalyze(env, request);
    if (url.pathname === "/api/report" && request.method === "GET") return await handleReport(env, request, url);
    return json({ ok: false, error: "not found" }, 404);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (url.pathname.startsWith("/api/")) return handleApi(env, request, url);
    return env.ASSETS.fetch(request);
  },
};

// Exported for offline unit tests (worker/test/worker.test.mjs). Not used by the runtime.
export const __test = { slugify, isFresh, isInFlight, isStatusStale, FRESH_DAYS, STALE_STATUS_MS };
