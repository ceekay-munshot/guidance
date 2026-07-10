/**
 * Munshot — Concall Deep Dive · Cloudflare Worker (STEP 10 — GO LIVE)
 * ---------------------------------------------------------------------------
 * Serves the static dashboard from ASSETS and owns /api/*. On-demand pipeline:
 *   client picks a company → POST /api/analyze → (if not cached/in-flight) the Worker
 *   dispatches the GitHub Action → the Action writes the report to KV → the client
 *   polls GET /api/report until it's done and renders it.
 *
 *   GET  /api/search?q=…     → { results:[{ticker,name,sector,country}] }  (Muns proxy, India only)
 *   GET  /api/universe       → company universe list (public/data/universe.json)  (search fallback)
 *   GET  /api/reports        → { reports:[…] } — the saved-runs library, newest first
 *   POST /api/analyze        → { status: "done"|"queued"|"running"|"error" }
 *   GET  /api/report?slug=…  → { status, stage?, report? }
 *   (anything else)          → env.ASSETS.fetch(request)
 *
 * Bindings (wrangler.jsonc):
 *   ASSETS   static-asset fetcher for ./public.
 *   REPORTS  KV namespace. Keys: report:<slug> (finished report JSON, has meta.generated_at),
 *            status:<slug> ({ state, stage?, updated_at, message }), index:reports (library array).
 *            The Action writes them via the KV REST API; the Worker READS them + writes status="queued".
 * Vars (wrangler.jsonc): GITHUB_REPO ("owner/repo"), GITHUB_BRANCH ("main").
 * Secrets (wrangler secret put): GITHUB_TOKEN (Actions read/write, for workflow_dispatch),
 *   MUNS_TOKEN (bearer for the Muns stock-search API). Both are used ONLY server-side and never
 *   returned in a response.
 * ---------------------------------------------------------------------------
 */

const WORKFLOW_FILE = "fetch-company.yml"; // the Action to dispatch (must accept `company` + `slug`)
const FRESH_DAYS = 14;                      // a report newer than this is served from cache, not re-run
const STALE_STATUS_MS = 25 * 60 * 1000;     // MUST exceed the workflow's timeout-minutes (20) so a legitimately
                                            // long run is never marked stale mid-flight (which would let a retry
                                            // re-dispatch and cancel-in-progress kill the near-done original). A
                                            // status older than this is presumed stuck (crash/missed error step).

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

/**
 * The canonical KV slug for a company. If the input exactly matches a universe entry's name OR
 * ticker, use that entry's curated slug — so aliases of the same company (e.g. "TCS" vs
 * "Tata Consultancy Services Ltd") share ONE cache key instead of dispatching duplicate runs.
 * Free-text companies not in the universe fall back to slugify(company). Always derived server-side.
 */
async function canonicalSlug(env, request, company) {
  const q = company.trim().toLowerCase();
  try {
    const universe = await readAssetJson(env, request, "/data/universe.json");
    if (Array.isArray(universe)) {
      const hit = universe.find((c) => (c.name || "").toLowerCase() === q || (c.ticker || "").toLowerCase() === q);
      if (hit && hit.slug) return slugify(hit.slug);
    }
  } catch { /* universe unavailable → fall back to the plain slug */ }
  return slugify(company);
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
 * Transform the Muns /stock/search response into a clean array, keeping ONLY India-listed stocks
 * (the pipeline resolves via Screener/BSE/NSE). `results` is an object keyed by ticker whose value
 * is [country, name, sector]; malformed/other-country/blank entries are dropped, null sector kept.
 */
export function munsToResults(payload) {
  const results = payload && payload.data && payload.data.results;
  if (!results || typeof results !== "object") return [];
  const out = [];
  for (const [ticker, val] of Object.entries(results)) {
    if (!Array.isArray(val)) continue;
    const [country, name, sector] = val;
    if (country !== "India" || !ticker || !name) continue;
    out.push({ ticker: String(ticker), name: String(name), sector: sector == null ? null : String(sector), country: "India" });
  }
  return out;
}

/** Sort a reports-index array newest-first by generated_at (stable, tolerant of missing dates). */
export function sortReports(list) {
  return (Array.isArray(list) ? list.slice() : []).sort((a, b) => String(b && b.generated_at || "").localeCompare(String(a && a.generated_at || "")));
}

// ── GET /api/search?q=… — Muns stock search, proxied so MUNS_TOKEN stays server-side ──
async function handleSearch(env, url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) return json({ ok: true, results: [] });
  if (!env.MUNS_TOKEN) return json({ ok: false, results: [], error: "search not configured" }); // client falls back to universe.json
  try {
    const res = await fetch("https://birdnest.muns.io/stock/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.MUNS_TOKEN}`, "Content-Type": "application/json", accept: "*/*" },
      body: JSON.stringify({ query: q, user_index: 124 }),
    });
    if (!res.ok) return json({ ok: false, results: [], error: `search HTTP ${res.status}` });
    return json({ ok: true, results: munsToResults(await res.json()) });
  } catch {
    return json({ ok: false, results: [], error: "search failed" });
  }
}

// ── GET /api/reports — the saved-runs library (newest first) ──
// Aggregates the per-slug `report-meta:<slug>` cards (race-free writes) rather than a shared array.
async function handleReports(env) {
  if (!env.REPORTS || !env.REPORTS.list) return json({ ok: true, reports: [] });
  const out = [];
  let cursor;
  do {
    const page = await env.REPORTS.list({ prefix: "report-meta:", cursor });
    for (const k of page.keys || []) { const e = await kvJson(env, k.name); if (e) out.push(e); }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return json({ ok: true, reports: sortReports(out) });
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
  const ticker = String(body.ticker || "").trim();
  if (!company) return json({ ok: false, status: "error", error: "missing company" }, 400);
  // The ticker is unique → one canonical KV key per stock, regardless of name spelling. Derived
  // server-side (never body.slug). Free text with no ticker falls back to a universe/name canonical.
  const slug = ticker ? slugify(ticker) : await canonicalSlug(env, request, company);
  if (!slug || slug === "company") return json({ ok: false, status: "error", error: "missing company" }, 400);
  const force = body.force === true;

  const [report, status] = await Promise.all([kvJson(env, `report:${slug}`), kvJson(env, `status:${slug}`)]);
  const reportT = report && report.meta && report.meta.generated_at ? Date.parse(report.meta.generated_at) : -Infinity;
  const statusT = status && status.updated_at ? Date.parse(status.updated_at) : -Infinity;
  const inFlightFresh = isInFlight(status) && !isStatusStale(status);
  const newerError = status && status.state === "error" && statusT > reportT; // a failed refresh after the cached report

  // Serve the fresh cache ONLY if nothing newer is pending — otherwise a failed/in-flight refresh
  // would be masked by the stale report and "Try again" could never start a replacement.
  if (report && isFresh(report) && !force && !newerError && !inFlightFresh) return json({ ok: true, slug, status: "done" });
  // A live run blocks a duplicate dispatch — but a stuck (stale) status, or an explicit force, re-runs.
  if (inFlightFresh && !force) return json({ ok: true, slug, status: status.state, stage: status.stage, message: status.message });

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return json({ ok: false, status: "error", error: "analysis is not configured on the server" }, 503);
  }
  if (env.REPORTS) await env.REPORTS.put(`status:${slug}`, JSON.stringify({ state: "queued", stage: "queued", updated_at: new Date().toISOString(), message: "Starting the analysis…" }));
  try {
    await dispatchWorkflow(env, { company, ticker, slug });
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
  if (isInFlight(status) && !isStatusStale(status)) return json({ ok: true, slug, status: status.state, stage: status.stage, message: status.message });

  const reportT = report && report.meta && report.meta.generated_at ? Date.parse(report.meta.generated_at) : -Infinity;
  const statusT = status && status.updated_at ? Date.parse(status.updated_at) : -Infinity;
  // A failure from a run AFTER the stored report was generated wins — don't hide a failed refresh.
  if (status && status.state === "error" && statusT > reportT) return json({ ok: false, slug, status: "error", error: status.message || "Analysis failed." });
  // A done status carries the report's generated_at. Accept the report as the completed run ONLY once
  // that report has actually propagated (Workers KV is eventually consistent — the new report can lag
  // its own done status). Until then keep the client polling rather than render an older cached report.
  const doneAt = status && status.state === "done" && status.generated_at ? Date.parse(status.generated_at) : NaN;
  if (Number.isFinite(doneAt)) {
    if (report && reportT >= doneAt) return json({ ok: true, slug, status: "done", report });
    return json({ ok: true, slug, status: "running", stage: "finalize", message: "Finishing up…" });
  }
  if (report) return json({ ok: true, slug, status: "done", report }); // report with no done-status to gate on
  if (status && status.state === "error") return json({ ok: false, slug, status: "error", error: status.message || "Analysis failed." });
  return json({ ok: false, slug, status: "unknown" });
}

async function handleApi(env, request, url) {
  try {
    if (url.pathname === "/api/search" && request.method === "GET") return await handleSearch(env, url);
    if (url.pathname === "/api/universe" && request.method === "GET") return await handleUniverse(env, request);
    if (url.pathname === "/api/reports" && request.method === "GET") return await handleReports(env);
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
export const __test = { slugify, isFresh, isInFlight, isStatusStale, munsToResults, sortReports, FRESH_DAYS, STALE_STATUS_MS };
