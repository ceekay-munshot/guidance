// selfcheck.mjs — structural self-check on the bundle's OWN output.
// Does not judge whether the numbers are *correct* (the owner validates that live) — only that
// the required fields exist, are finite, are internally consistent, and a transcript was fetched
// (or is explicitly PPT-only/absent with a reason).

export function selfCheck(b, transcript, minChars = 2000) {
  const problems = [];
  const finite = (v) => typeof v === "number" && isFinite(v);

  for (const k of ["cmp", "shares_out_cr", "market_cap_cr"]) if (!finite(b.inputs?.[k])) problems.push(`inputs.${k} missing/non-finite`);
  if (typeof b.inputs?.cmp_date !== "string") problems.push("inputs.cmp_date missing");
  if (!finite(b.inputs?.net_debt_cr)) problems.push("inputs.net_debt_cr missing (note, not fatal)");
  for (const k of ["revenue", "ebitda", "pat"]) if (!finite(b.fy26a?.[k])) problems.push(`fy26a.${k} missing/non-finite`);

  // consistency: market cap ≈ cmp × shares (within 2%)
  if (finite(b.inputs?.cmp) && finite(b.inputs?.shares_out_cr) && finite(b.inputs?.market_cap_cr)) {
    const implied = b.inputs.cmp * b.inputs.shares_out_cr;
    if (Math.abs(implied - b.inputs.market_cap_cr) / b.inputs.market_cap_cr > 0.02) problems.push("market cap ≠ cmp × shares (>2%)");
  }

  // documents: a claimed transcript must actually have text; otherwise PPT-only/absent with a reason
  if (b.meta?.transcript_available) {
    if (!transcript || transcript.chars < minChars) problems.push(`transcript text too short (${transcript?.chars || 0} < ${minChars}) — fetch likely failed`);
  } else if (!(b.diagnostics?.notes || []).some((n) => /PPT-only|no concall|transcript/i.test(n))) {
    problems.push("transcript unavailable but no reason recorded");
  }

  // critical = required numbers present + a transcript that's either fetched or legitimately
  // absent-with-reason. net_debt / consistency notes are warnings, not blockers.
  const critical = problems.filter((p) => /inputs\.(cmp|shares_out|market_cap)|fy26a\.(revenue|ebitda|pat)|cmp_date|transcript/i.test(p));
  return { ok: critical.length === 0, critical, problems };
}
