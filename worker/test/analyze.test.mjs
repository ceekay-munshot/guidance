// analyze.test.mjs — offline unit tests for the frontend's pure Analyze helpers (no DOM, no deps).
// Run: node worker/test/analyze.test.mjs

import { slugify, resolveTarget, pollDecision } from "../../public/js/analyze.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };

// ── slugify (must match Worker + pipeline) ──
ok(slugify("Navin Fluorine International Ltd") === "navin-fluorine-international-ltd", "slugify: name → slug");
ok(slugify("Tata Consultancy Services (TCS)") === "tata-consultancy-services-tcs", "slugify: strips punctuation");
ok(slugify("  ") === "company", "slugify: blank → 'company' sentinel");

// ── resolveTarget: universe pick keeps its slug; free text is slugified ──
const picked = resolveTarget({ name: "SRF Ltd", ticker: "SRF", slug: "srf-ltd" }, "ignored");
ok(picked.slug === "srf-ltd" && picked.ticker === "SRF", "resolveTarget: universe selection keeps canonical slug");
const free = resolveTarget(null, "Deepak Nitrite");
ok(free.slug === "deepak-nitrite" && free.name === "Deepak Nitrite" && free.ticker === "", "resolveTarget: free text → slugified target");
ok(resolveTarget(null, "   ") === null, "resolveTarget: empty input → null");

// ── pollDecision: the poll-loop state machine ──
ok(pollDecision({ status: "done", report: { meta: {} } }).action === "done", "pollDecision: done+report → done");
ok(pollDecision({ status: "done" }).action !== "done", "pollDecision: done WITHOUT report is not 'done'");
ok(pollDecision({ status: "queued" }).action === "wait", "pollDecision: queued → wait");
ok(pollDecision({ status: "running" }).action === "wait", "pollDecision: running → wait");
ok(pollDecision({ status: "unknown" }).action === "wait", "pollDecision: unknown → wait (tolerate KV lag)");
const err = pollDecision({ status: "error", error: "not resolvable on Screener" });
ok(err.action === "error" && /not resolvable/.test(err.message), "pollDecision: error → error + message");
ok(pollDecision({}).action === "error", "pollDecision: garbage → error (never silently waits forever)");

console.log(fails === 0 ? "\nANALYZE HELPERS (Step 10) OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
