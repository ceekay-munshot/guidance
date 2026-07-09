/**
 * Munshot — Concall Deep Dive · Cloudflare Worker
 * ---------------------------------------------------------------------------
 * Serves the static dashboard from the ASSETS binding and owns the /api/* routes.
 *
 *   GET  /api/universe       → company universe list (public/data/universe.json)
 *   POST /api/analyze        → { ok, slug, status } — triggers a run (stubbed here)
 *   GET  /api/report?slug=…  → the finished report JSON for a company
 *   (anything else)          → falls through to env.ASSETS.fetch(request)
 *
 * ── STEP 1 (this file): STUBS ONLY. No external calls. ──
 * /api/universe and /api/report read the local fixtures via the ASSETS binding.
 * /api/analyze pretends the report is already cached and returns status:"done"
 * so the frontend's request→poll loop is exercisable today.
 *
 * ── STEP 10 will make these real. The contract it will use: ──
 * Secrets (set via `wrangler secret put <NAME>`, never committed):
 *   GITHUB_TOKEN   fine-grained PAT with `actions:write` on the repo below.
 *   GITHUB_REPO    "owner/repo" that hosts .github/workflows/analyze.yml.
 *   GITHUB_BRANCH  git ref to dispatch against, e.g. "main".
 * Bindings (wrangler.jsonc):
 *   ASSETS         static-asset fetcher for ./public (already wired).
 *   REPORTS        KV namespace holding finished reports, keyed by slug.
 *
 * Real /api/analyze (step 10):
 *   1. Look up KV `REPORTS.get(slug)`. If present and fresh → return status:"done".
 *   2. Else POST to the GitHub REST API to dispatch the workflow:
 *        POST https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/analyze.yml/dispatches
 *        Authorization: Bearer ${GITHUB_TOKEN}
 *        body: { ref: GITHUB_BRANCH, inputs: { slug, company, ticker } }
 *      and return status:"queued". The frontend keeps polling /api/report.
 * Real /api/report (step 10):
 *   Return `REPORTS.get(slug, { type: "json" })`; 404 until the Action writes it.
 *
 * How the Action authenticates to KV (step 10, runs in GitHub Actions):
 *   The pipeline writes the report to KV using the Cloudflare API with repo
 *   secrets CF_ACCOUNT_ID + CF_API_TOKEN (token scoped to "Workers KV Storage:Edit"),
 *   PUT-ing to /accounts/{account}/storage/kv/namespaces/{REPORTS_ID}/values/{slug}.
 *   The Worker never writes KV; it only reads.
 * ---------------------------------------------------------------------------
 */

// Permissive CORS — this is a public read API; tighten the origin in step 10 if needed.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** JSON response with CORS + no-store (fixtures may change between deploys). */
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

/** Read a static asset (by absolute path) through the ASSETS binding and parse it as JSON. */
async function readAssetJson(env, request, path) {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const res = await env.ASSETS.fetch(new Request(url.toString(), { method: "GET" }));
  if (!res.ok) throw new Error(`asset ${path} → ${res.status}`);
  return res.json();
}

/** GET /api/universe — the company universe for the search box. */
async function handleUniverse(env, request) {
  const universe = await readAssetJson(env, request, "/data/universe.json");
  return json(universe);
}

/**
 * POST /api/analyze — STUB. Accepts { slug } (JSON body or ?slug=) and pretends
 * the report is already cached. Step 10 will dispatch the GitHub Action here.
 */
async function handleAnalyze(env, request, url) {
  let slug = url.searchParams.get("slug") || "";
  if (!slug) {
    try {
      const body = await request.json();
      slug = (body && body.slug) || "";
    } catch {
      /* no/invalid body — fall through to the guard below */
    }
  }
  if (!slug) return json({ ok: false, error: "missing slug" }, 400);
  // STUB: no dispatch, no KV. Report is served straight from the fixture.
  return json({ ok: true, slug, status: "done" });
}

/**
 * GET /api/report?slug=… — STUB. Always returns the sample fixture regardless of
 * slug. Step 10 will return REPORTS.get(slug) from KV (404 until the Action writes it).
 */
async function handleReport(env, request, url) {
  const slug = url.searchParams.get("slug");
  if (!slug) return json({ ok: false, error: "missing slug" }, 400);
  const report = await readAssetJson(env, request, "/data/sample-report.json");
  return json(report);
}

async function handleApi(env, request, url) {
  const path = url.pathname;
  try {
    if (path === "/api/universe" && request.method === "GET") {
      return await handleUniverse(env, request);
    }
    if (path === "/api/analyze" && request.method === "POST") {
      return await handleAnalyze(env, request, url);
    }
    if (path === "/api/report" && request.method === "GET") {
      return await handleReport(env, request, url);
    }
    return json({ ok: false, error: "not found" }, 404);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(env, request, url);
    }

    // Everything else → static assets (index.html, js, css, data, …)
    return env.ASSETS.fetch(request);
  },
};
