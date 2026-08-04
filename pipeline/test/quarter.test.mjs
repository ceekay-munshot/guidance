// quarter.test.mjs — resolveQuarter() reconciles the quarter parsed from the ACTUAL latest concall
// with the date-heuristic's expectation. Confirms we always analyse the real parsed quarter, that a
// company reporting EARLY (newer than expected) is still "confirmed" (the Five-Star case), and that
// the diagnostic note is worded correctly in each direction. Pure module — safe in the offline stage.
// Run: node pipeline/test/quarter.test.mjs

import { quarterOrder, resolveQuarter } from "../lib/util.mjs";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };

// ── quarterOrder: sortable, newer = higher ──
ok(quarterOrder("Q1FY27") > quarterOrder("Q4FY26"), "Q1FY27 orders after Q4FY26 (the very next quarter)");
ok(quarterOrder("Q4FY26") > quarterOrder("Q3FY26"), "Q4FY26 orders after Q3FY26");
ok(quarterOrder("garbage") === null && quarterOrder(null) === null, "unparseable quarter → null");

// ── the Five-Star case: parsed Q1FY27, heuristic expected Q4FY26 (company reported early) ──
{
  const r = resolveQuarter("Q1FY27", "Q4FY26");
  ok(r.quarter === "Q1FY27", "analyses the real parsed quarter (Q1FY27), not the expected one");
  ok(r.confirmed === true, "newer-than-expected quarter is CONFIRMED (reported early, not a problem)");
  ok(/reported early/.test(r.note) && /Q1FY27/.test(r.note), "note says reported early, not 'may not be posted'");
  ok(!/may not be posted/.test(r.note), "note does NOT use the misleading stale wording");
}

// ── parsed exactly matches expectation → confirmed, no note ──
{
  const r = resolveQuarter("Q4FY26", "Q4FY26");
  ok(r.quarter === "Q4FY26" && r.confirmed === true && r.note === null, "parsed == expected → confirmed, silent");
}

// ── parsed is OLDER than expected (genuinely stale data) → unconfirmed + honest warning ──
{
  const r = resolveQuarter("Q3FY26", "Q4FY26");
  ok(r.quarter === "Q3FY26", "still analyses the latest available quarter");
  ok(r.confirmed === false, "older-than-expected quarter is unconfirmed (stale)");
  ok(/older than/.test(r.note) && /may not be posted/.test(r.note), "stale note explains the expected quarter isn't up yet");
}

// ── nothing parsed → fall back to the date-expected quarter, unconfirmed ──
{
  const r = resolveQuarter(null, "Q4FY26");
  ok(r.quarter === "Q4FY26" && r.confirmed === false, "no parse → date-expected fallback, unconfirmed");
  ok(/no quarter could be read/.test(r.note), "fallback note explains why it's unconfirmed");
}

// ── nothing parsed AND no expectation → null quarter, no note (defensive) ──
{
  const r = resolveQuarter(null, null);
  ok(r.quarter === null && r.confirmed === false && r.note === null, "nothing to go on → null, unconfirmed, silent");
}

console.log(fails === 0 ? "\nQUARTER (resolveQuarter) OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
