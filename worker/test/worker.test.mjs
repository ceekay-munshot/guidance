// worker.test.mjs — offline unit tests for the Step-10 Worker (no network, no deps).
// Run: node worker/test/worker.test.mjs
// Mocks the REPORTS KV (Map-backed) and ASSETS, and stubs global fetch to capture workflow
// dispatches — verifying server-derived slugs, freshness caching, in-flight dedup + stale recovery,
// the report contract, and that the token never leaks.

import worker, { __test } from "../index.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };

const CO = "Navin Fluorine";
const SLUG = __test.slugify(CO); // "navin-fluorine" — the server-derived KV key
const nowIso = () => new Date().toISOString();
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();
const j = (o) => JSON.stringify(o);
const freshReport = { meta: { slug: SLUG, generated_at: nowIso() } };
const staleReport = { meta: { slug: SLUG, generated_at: "2020-01-01T00:00:00Z" } };

// ── harness ──
let dispatches = [];
function stubDispatchOk() {
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/actions/workflows/")) { dispatches.push({ url: String(url), body: JSON.parse(opts.body) }); return new Response(null, { status: 204 }); }
    return new Response("{}", { status: 200 });
  };
}
function makeEnv({ token = "tok", kv = {} } = {}) {
  const store = new Map(Object.entries(kv));
  return {
    GITHUB_TOKEN: token, GITHUB_REPO: "ceekay-munshot/guidance", GITHUB_BRANCH: "main",
    REPORTS: {
      get: async (k, opt) => { const v = store.get(k); return v == null ? null : (opt && opt.type === "json" ? JSON.parse(v) : v); },
      put: async (k, v) => { store.set(k, String(v)); },
    },
    ASSETS: { fetch: async (req) => {
      if (new URL(req.url).pathname === "/data/universe.json") {
        return new Response(JSON.stringify([{ name: "Navin Fluorine International Ltd", ticker: "NAVINFLUOR", slug: "navin-fluorine-international" }]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    } },
    __store: store,
  };
}
const post = (env, path, body) => worker.fetch(new Request(`https://x${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
const get = (env, path) => worker.fetch(new Request(`https://x${path}`, { method: "GET" }), env);
stubDispatchOk();

// ── helpers ──
ok(SLUG === "navin-fluorine", "slugify derives the KV key from the company name");
ok(__test.isFresh(freshReport) && !__test.isFresh(staleReport), "isFresh: recent true, old false");
ok(__test.isStatusStale({ state: "running", updated_at: agoIso(30 * 60 * 1000) }) === true, "isStatusStale: 30-min-old status is stale (> 25-min cutoff)");
ok(__test.isStatusStale({ state: "running", updated_at: agoIso(18 * 60 * 1000) }) === false, "isStatusStale: 18-min run (< 20-min job timeout) is NOT stale");

// ── analyze: cold start → queued + one dispatch under the DERIVED slug ──
dispatches = [];
let env = makeEnv();
let body = await (await post(env, "/api/analyze", { company: CO })).json();
ok(body.status === "queued" && body.slug === SLUG && dispatches.length === 1, "cold analyze → queued + one dispatch, server slug");
ok(env.__store.has(`status:${SLUG}`) && dispatches[0].body.inputs.slug === SLUG, "dispatch carries the server-derived slug");

// ── P1: a client-supplied slug is IGNORED (no cache poisoning) ──
dispatches = [];
env = makeEnv();
body = await (await post(env, "/api/analyze", { company: CO, slug: "some-other-company" })).json();
ok(body.slug === SLUG && dispatches[0].body.inputs.slug === SLUG, "client slug is ignored — slug derived from company");
ok(env.__store.has(`status:${SLUG}`) && !env.__store.has("status:some-other-company"), "no KV write under the attacker-chosen key");

// ── alias dedup: a company's ticker and full name map to ONE canonical universe slug ──
dispatches = [];
env = makeEnv();
const r1 = await (await post(env, "/api/analyze", { company: "NAVINFLUOR" })).json();                       // ticker
ok(r1.slug === "navin-fluorine-international" && dispatches.length === 1, "ticker alias → canonical universe slug");
const r2 = await (await post(env, "/api/analyze", { company: "Navin Fluorine International Ltd" })).json(); // full name (status now in-flight)
ok(r2.slug === "navin-fluorine-international" && dispatches.length === 1, "name alias → same key, no duplicate dispatch");

// ── analyze: fresh cached report → done, no dispatch ──
dispatches = [];
body = await (await post(makeEnv({ kv: { [`report:${SLUG}`]: j(freshReport) } }), "/api/analyze", { company: CO })).json();
ok(body.status === "done" && dispatches.length === 0, "fresh report → done, no dispatch");

// ── analyze: fresh in-flight job → return state, NO duplicate dispatch ──
dispatches = [];
body = await (await post(makeEnv({ kv: { [`status:${SLUG}`]: j({ state: "running", updated_at: nowIso() }) } }), "/api/analyze", { company: CO })).json();
ok(body.status === "running" && dispatches.length === 0, "fresh in-flight job → returns state, no duplicate dispatch");

// ── analyze: STALE in-flight job → re-dispatches (stuck-run recovery) ──
dispatches = [];
body = await (await post(makeEnv({ kv: { [`status:${SLUG}`]: j({ state: "queued", updated_at: agoIso(30 * 60 * 1000) }) } }), "/api/analyze", { company: CO })).json();
ok(body.status === "queued" && dispatches.length === 1, "stale in-flight job → re-dispatches (not stuck forever)");

// ── analyze: fresh report + a NEWER failed refresh → re-dispatches (Try again escapes) ──
dispatches = [];
const recentRpt = { meta: { slug: SLUG, generated_at: agoIso(60 * 1000) } };
body = await (await post(makeEnv({ kv: { [`report:${SLUG}`]: j(recentRpt), [`status:${SLUG}`]: j({ state: "error", updated_at: nowIso(), message: "failed" }) } }), "/api/analyze", { company: CO })).json();
ok(body.status === "queued" && dispatches.length === 1, "fresh report + newer error → re-dispatches (not masked by cache)");

// ── analyze: fresh report + an OLD error → still served from cache ──
dispatches = [];
body = await (await post(makeEnv({ kv: { [`report:${SLUG}`]: j(freshReport), [`status:${SLUG}`]: j({ state: "error", updated_at: agoIso(60 * 60 * 1000), message: "old" }) } }), "/api/analyze", { company: CO })).json();
ok(body.status === "done" && dispatches.length === 0, "fresh report + old error → served from cache");

// ── analyze: force bypasses freshness AND a live status ──
dispatches = [];
body = await (await post(makeEnv({ kv: { [`report:${SLUG}`]: j(freshReport), [`status:${SLUG}`]: j({ state: "running", updated_at: nowIso() }) } }), "/api/analyze", { company: CO, force: true })).json();
ok(body.status === "queued" && dispatches.length === 1, "force → re-dispatches past cache + live status");

// ── analyze: stale report → re-runs ──
dispatches = [];
body = await (await post(makeEnv({ kv: { [`report:${SLUG}`]: j(staleReport) } }), "/api/analyze", { company: CO })).json();
ok(body.status === "queued" && dispatches.length === 1, "stale report → re-dispatches");

// ── analyze: not configured / bad input ──
dispatches = [];
let res = await post(makeEnv({ token: null }), "/api/analyze", { company: CO });
ok(res.status === 503 && dispatches.length === 0, "missing GITHUB_TOKEN → 503, never dispatches");
ok((await post(makeEnv(), "/api/analyze", {})).status === 400, "analyze with no company → 400");

// ── report: contract ──
body = await (await get(makeEnv({ kv: { [`report:${SLUG}`]: j(freshReport) } }), `/api/report?slug=${SLUG}`)).json();
ok(body.status === "done" && body.report && body.report.meta.slug === SLUG, "report present (no run) → done + the report");

// finding-5: a FRESH in-flight run must win over an old cached report (don't serve stale on regenerate)
body = await (await get(makeEnv({ kv: { [`report:${SLUG}`]: j(freshReport), [`status:${SLUG}`]: j({ state: "running", updated_at: nowIso() }) } }), `/api/report?slug=${SLUG}`)).json();
ok(body.status === "running", "fresh in-flight run wins over an existing report (client keeps polling)");

// but a STALE in-flight status must not hide a usable report forever
body = await (await get(makeEnv({ kv: { [`report:${SLUG}`]: j(freshReport), [`status:${SLUG}`]: j({ state: "running", updated_at: agoIso(30 * 60 * 1000) }) } }), `/api/report?slug=${SLUG}`)).json();
ok(body.status === "done" && body.report, "stale in-flight status falls back to serving the report");

// done-status gate (KV eventual consistency): only accept the report once it has caught up
const T = nowIso();
const doneStatus = j({ state: "done", updated_at: T, generated_at: T });
body = await (await get(makeEnv({ kv: { [`report:${SLUG}`]: j({ meta: { slug: SLUG, generated_at: T } }), [`status:${SLUG}`]: doneStatus } }), `/api/report?slug=${SLUG}`)).json();
ok(body.status === "done" && body.report, "done + report caught up to generated_at → done");
body = await (await get(makeEnv({ kv: { [`report:${SLUG}`]: j(staleReport), [`status:${SLUG}`]: doneStatus } }), `/api/report?slug=${SLUG}`)).json();
ok(body.status === "running", "done status but only an OLD report readable (KV lag) → keep polling (no stale render)");
body = await (await get(makeEnv({ kv: { [`status:${SLUG}`]: doneStatus } }), `/api/report?slug=${SLUG}`)).json();
ok(body.status === "running", "done status but report not yet visible (first-run lag) → keep polling");

// a failed refresh NEWER than the cached report surfaces the error (doesn't hide behind stale data)
body = await (await get(makeEnv({ kv: { [`report:${SLUG}`]: j(staleReport), [`status:${SLUG}`]: j({ state: "error", updated_at: nowIso(), message: "run failed" }) } }), `/api/report?slug=${SLUG}`)).json();
ok(body.status === "error" && /run failed/.test(body.error), "failed refresh (newer than report) → error, not the stale report");
// but an OLD error behind a NEWER report still serves the report
body = await (await get(makeEnv({ kv: { [`report:${SLUG}`]: j(freshReport), [`status:${SLUG}`]: j({ state: "error", updated_at: agoIso(60 * 60 * 1000), message: "old" }) } }), `/api/report?slug=${SLUG}`)).json();
ok(body.status === "done", "an old error behind a newer report → still serves the report");

body = await (await get(makeEnv({ kv: { [`status:${SLUG}`]: j({ state: "error", message: "not resolvable" }) } }), `/api/report?slug=${SLUG}`)).json();
ok(body.status === "error" && /not resolvable/.test(body.error), "status error (no report) → error + message");
ok((await (await get(makeEnv(), `/api/report?slug=${SLUG}`)).json()).status === "unknown", "no report/status → unknown");

// ── the token is never leaked in a response ──
globalThis.fetch = async (url) => { if (String(url).includes("/actions/workflows/")) return new Response("boom", { status: 500 }); return new Response("{}", { status: 200 }); };
res = await post(makeEnv({ token: "SUPER_SECRET_TOKEN" }), "/api/analyze", { company: "X" });
ok(!(await res.text()).includes("SUPER_SECRET_TOKEN"), "a dispatch failure never leaks the token in the response");

console.log(fails === 0 ? "\nWORKER (Step 10) OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
