// selfcheck.test.mjs — structural self-check gating. Confirms the fetch-company bundle passes/fails
// for the right reasons, and specifically that a lender (bank/NBFC) with no EBITDA/OPM is NOT
// hard-failed (the Five-Star Business Finance regression, where Screener reports "Financing Profit"
// instead of "Operating Profit"). Pure module, no deps — safe in the pre-install offline test stage.
// Run: node pipeline/test/selfcheck.test.mjs

import { selfCheck } from "../lib/selfcheck.mjs";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };

// A structurally-complete bundle that passes cleanly (non-financial: EBITDA present).
const baseBundle = () => ({
  meta: { transcript_available: true, is_financial: false },
  inputs: { cmp: 100, cmp_date: "2026-08-04", shares_out_cr: 10, market_cap_cr: 1000, net_debt_cr: 0 },
  fy26a: { revenue: 3218, ebitda: 900, ebitda_margin_pct: 28, pat: 1099 },
  diagnostics: { notes: [] },
});
const goodTranscript = { chars: 60000 };

// sanity: a complete non-financial bundle passes
{
  const c = selfCheck(baseBundle(), goodTranscript);
  ok(c.ok && c.critical.length === 0, "complete non-financial bundle → ok, no criticals");
}

// ANY company with a missing EBITDA → NOT fatal (best-effort: EBITDA is null-tolerant everywhere,
// so a gap degrades the report rather than denying it — the whole point of "always move forward").
{
  const b = baseBundle(); b.fy26a.ebitda = null;
  const c = selfCheck(b, goodTranscript);
  ok(c.ok, "non-financial + missing EBITDA → ok (best-effort, not a blocker)");
  ok(c.critical.every((p) => !/fy26a\.ebitda/.test(p)), "missing EBITDA is never counted critical");
}

// LENDER (bank/NBFC) with a missing EBITDA → NOT fatal (Five-Star regression: the report still runs)
{
  const b = baseBundle(); b.meta.is_financial = true; b.fy26a.ebitda = null; b.fy26a.ebitda_margin_pct = null;
  const c = selfCheck(b, goodTranscript);
  ok(c.ok, "lender + missing EBITDA → ok (no hard fail)");
  ok(c.critical.every((p) => !/fy26a\.ebitda/.test(p)), "lender: the EBITDA note is not counted as critical");
  ok(c.problems.some((p) => /fy26a\.ebitda.*not fatal/.test(p)), "lender: EBITDA absence is still recorded as a note");
}

// a lender is NOT a free pass: revenue is still required for everyone
{
  const b = baseBundle(); b.meta.is_financial = true; b.fy26a.ebitda = null; b.fy26a.revenue = null;
  const c = selfCheck(b, goodTranscript);
  ok(!c.ok && c.critical.some((p) => /fy26a\.revenue/.test(p)), "lender + missing revenue → still fatal");
}

// a lender is NOT a free pass: PAT is still required for everyone
{
  const b = baseBundle(); b.meta.is_financial = true; b.fy26a.ebitda = null; b.fy26a.pat = null;
  const c = selfCheck(b, goodTranscript);
  ok(!c.ok && c.critical.some((p) => /fy26a\.pat/.test(p)), "lender + missing PAT → still fatal");
}

// a claimed transcript that came back too short is fatal for a lender too (documents guardrail kept)
{
  const b = baseBundle(); b.meta.is_financial = true; b.fy26a.ebitda = null;
  const c = selfCheck(b, { chars: 10 });
  ok(!c.ok && c.critical.some((p) => /transcript/.test(p)), "lender + empty transcript → still fatal");
}

// net_debt missing stays a non-fatal note (unchanged behavior, relevant since lenders often lack it)
{
  const b = baseBundle(); b.inputs.net_debt_cr = null;
  const c = selfCheck(b, goodTranscript);
  ok(c.ok && c.problems.some((p) => /net_debt_cr.*not fatal/.test(p)), "missing net_debt → note, not fatal");
}

console.log(fails === 0 ? "\nSELF-CHECK (financial-company gating) OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
