// worker.test.mjs — offline unit tests for the Step-10 Worker (no network, no deps).
// Run: node worker/test/worker.test.mjs
// Mocks the REPORTS KV (Map-backed) and ASSETS, and stubs global fetch to count workflow
// dispatches — verifying freshness caching, in-flight dedup, dispatch, and the report contract.

import worker, { __test } from "../index.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };

// ── harness ──
let dispatches = [];
globalThis.fetch = async (url) => {
  if (String(url).includes("/actions/workflows/")) { dispatches.push(String(url)); return new Response(null, { status: 204 }); }
  return new Response("{}", { status: 200 });
};

function makeEnv({ token = "tok", kv = {} } = {}) {
  const store = new Map(Object.entries(kv));
  return {
    GITHUB_TOKEN: token, GITHUB_REPO: "ceekay-munshot/guidance", GITHUB_BRANCH: "main",
    REPORTS: {
      get: async (k, opt) => { const v = store.get(k); return v == null ? null : (opt && opt.type === "json" ? JSON.parse(v) : v); },
      put: async (k, v) => { store.set(k, String(v)); },
    },
    ASSETS: { fetch: async () => new Response("{}", { status: 200 }) },
    __store: store,
  };
}
const post = (env, path, body) => worker.fetch(new Request(`https://x${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
const get = (env, path) => worker.fetch(new Request(`https://x${path}`, { method: "GET" }), env);
const freshReport = { meta: { slug: "navinfluor", generated_at: new Date().toISOString() } };
const staleReport = { meta: { slug: "navinfluor", generated_at: "2020-01-01T00:00:00Z" } };
const j = (o) => JSON.stringify(o);

// ── helpers ──
ok(__test.slugify("Navin Fluorine International Ltd") === "navin-fluorine-international-ltd", "slugify matches the shared convention");
ok(__test.isFresh(freshReport) === true && __test.isFresh(staleReport) === false, "isFresh: recent true, old false");

// ── analyze: cold start → queued + one dispatch ──
dispatches = [];
let env = makeEnv();
let res = await post(env, "/api/analyze", { company: "Navin Fluorine", slug: "navinfluor" });
let body = await res.json();
ok(body.status === "queued" && dispatches.length === 1, "cold analyze → queued + dispatches the Action once");
ok(JSON.parse(env.__store.get("status:navinfluor")).state === "queued", "cold analyze wrote status:navinfluor = queued");

// ── analyze: fresh cached report → done, NO dispatch ──
dispatches = [];
env = makeEnv({ kv: { "report:navinfluor": j(freshReport) } });
body = await (await post(env, "/api/analyze", { company: "Navin Fluorine", slug: "navinfluor" })).json();
ok(body.status === "done" && dispatches.length === 0, "fresh report → done, no dispatch (cache)");

// ── analyze: job already in flight → return state, NO duplicate dispatch ──
dispatches = [];
env = makeEnv({ kv: { "status:navinfluor": j({ state: "running" }) } });
body = await (await post(env, "/api/analyze", { company: "Navin Fluorine", slug: "navinfluor" })).json();
ok(body.status === "running" && dispatches.length === 0, "in-flight job → returns state, no duplicate dispatch");

// ── analyze: force re-runs even when fresh ──
dispatches = [];
env = makeEnv({ kv: { "report:navinfluor": j(freshReport) } });
body = await (await post(env, "/api/analyze", { company: "Navin Fluorine", slug: "navinfluor", force: true }).then((r) => r)).json();
ok(body.status === "queued" && dispatches.length === 1, "force bypasses freshness → dispatches");

// ── analyze: stale report → re-runs ──
dispatches = [];
env = makeEnv({ kv: { "report:navinfluor": j(staleReport) } });
body = await (await post(env, "/api/analyze", { company: "Navin Fluorine", slug: "navinfluor" })).json();
ok(body.status === "queued" && dispatches.length === 1, "stale report → re-dispatches");

// ── analyze: not configured (no token) → 503, no dispatch ──
dispatches = [];
env = makeEnv({ token: null }); // null (not undefined) so it isn't replaced by the destructuring default
res = await post(env, "/api/analyze", { company: "Navin Fluorine", slug: "navinfluor" });
ok(res.status === 503 && dispatches.length === 0, "missing GITHUB_TOKEN → 503, never dispatches");

// ── analyze: missing company → 400 ──
res = await post(makeEnv(), "/api/analyze", {});
ok(res.status === 400, "analyze with no company → 400");

// ── report: done / queued / error / unknown ──
env = makeEnv({ kv: { "report:navinfluor": j(freshReport) } });
body = await (await get(env, "/api/report?slug=navinfluor")).json();
ok(body.status === "done" && body.report && body.report.meta.slug === "navinfluor", "report present → done + the report");

env = makeEnv({ kv: { "status:navinfluor": j({ state: "running", message: "Analyzing…" }) } });
body = await (await get(env, "/api/report?slug=navinfluor")).json();
ok(body.status === "running", "status running → running (client keeps polling)");

env = makeEnv({ kv: { "status:navinfluor": j({ state: "error", message: "not resolvable" }) } });
body = await (await get(env, "/api/report?slug=navinfluor")).json();
ok(body.status === "error" && /not resolvable/.test(body.error), "status error → error + message");

body = await (await get(makeEnv(), "/api/report?slug=navinfluor")).json();
ok(body.status === "unknown", "no report/status → unknown");

// ── the token is never leaked in a response ──
dispatches = [];
globalThis.fetch = async (url) => { if (String(url).includes("/actions/workflows/")) return new Response("boom", { status: 500 }); return new Response("{}", { status: 200 }); };
res = await post(makeEnv({ token: "SUPER_SECRET_TOKEN" }), "/api/analyze", { company: "X", slug: "x" });
const raw = await res.text();
ok(!raw.includes("SUPER_SECRET_TOKEN"), "a dispatch failure never leaks the token in the response");

console.log(fails === 0 ? "\nWORKER (Step 10) OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
