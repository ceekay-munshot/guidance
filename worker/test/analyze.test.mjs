// analyze.test.mjs — offline unit tests for the frontend's pure Analyze helpers (no DOM, no deps).
// Run: node worker/test/analyze.test.mjs

import {
  slugify, resolveTarget, pollDecision, STAGES, CHECKLIST_STAGES, stageInfo, sortReports, relativeTime,
  serializeInflight, parseInflight,
} from "../../public/js/analyze.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };

// ── slugify (must match Worker + pipeline) ──
ok(slugify("Navin Fluorine International Ltd") === "navin-fluorine-international-ltd", "slugify: name → slug");
ok(slugify("Tata Consultancy Services (TCS)") === "tata-consultancy-services-tcs", "slugify: strips punctuation");
ok(slugify("  ") === "company", "slugify: blank → 'company' sentinel");

// ── resolveTarget: slug is derived from the TICKER when present (matches the Worker's key) ──
const picked = resolveTarget({ name: "Reliance Industries Ltd", ticker: "RELIANCE" }, "ignored");
ok(picked.slug === "reliance" && picked.ticker === "RELIANCE", "resolveTarget: slug from ticker (unique key)");
const free = resolveTarget(null, "Deepak Nitrite");
ok(free.slug === "deepak-nitrite" && free.name === "Deepak Nitrite" && free.ticker === "", "resolveTarget: free text → slugified name");
ok(resolveTarget(null, "   ") === null, "resolveTarget: empty input → null");

// ── STAGES / progress mapping ──
ok(STAGES[0].key === "queued" && STAGES[STAGES.length - 1].key === "done", "STAGES: bookended queued → done");
ok(!CHECKLIST_STAGES.some((s) => s.key === "queued" || s.key === "done"), "CHECKLIST_STAGES: excludes the synthetic bookends");
ok(stageInfo("extract").pct === 50 && /commentary/i.test(stageInfo("extract").label), "stageInfo: extract → 50% + client label");
ok(stageInfo("nonsense").index === 0, "stageInfo: unknown stage → queued start");
ok(stageInfo("verify").index > stageInfo("extract").index, "stageInfo: index increases along the pipeline (monotonic progress)");

// ── sortReports (client mirror) ──
ok(sortReports([{ generated_at: "2026-01-01" }, { generated_at: "2026-06-01" }])[0].generated_at === "2026-06-01", "sortReports: newest first");

// ── relativeTime ──
const now = Date.parse("2026-07-09T12:00:00Z");
ok(relativeTime("2026-07-09T11:59:40Z", now) === "just now", "relativeTime: <45s → just now");
ok(relativeTime("2026-07-09T11:30:00Z", now) === "30 mins ago", "relativeTime: 30 min");
ok(relativeTime("2026-07-09T09:00:00Z", now) === "3 hours ago", "relativeTime: 3 hours");
ok(relativeTime("2026-07-06T12:00:00Z", now) === "3 days ago", "relativeTime: 3 days");
ok(relativeTime(null, now) === "recently", "relativeTime: missing → recently");

// ── resume (in-flight persistence) ──
const s = serializeInflight({ slug: "reliance", company: "Reliance", ticker: "RELIANCE", startedAt: 123 });
ok(parseInflight(s).slug === "reliance" && parseInflight(s).ticker === "RELIANCE", "inflight: serialize → parse round-trips");
ok(serializeInflight(null) === "" && serializeInflight({}) === "", "inflight: no slug → empty (clears)");
ok(parseInflight("") === null && parseInflight("{bad json") === null, "inflight: junk → null");

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
