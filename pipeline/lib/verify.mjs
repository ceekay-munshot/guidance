// verify.mjs — PURE functions (no network) for Step 8's second-model verification pass.
// Cross-checks the TRANSCRIPT-sourced claims Step 7 produced (C.1 guidance, C.3 expansion_flags,
// and B's transcript-derived facts) against transcript.txt via a second model, then conservatively
// DROPS only the claims the verifier marks clearly "not in transcript" — logging ALL verdicts to a
// sidecar audit (verification.json). This is an INTERNAL quality tool: it never adds a visible
// section to the client report. Deterministic and unit-testable without any LLM call.

const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

/**
 * Flatten the report's transcript-sourced claims into a stable, referenceable list. Each claim gets
 * a `ref` the verifier echoes back so we can map a verdict to the exact array element to prune.
 * B facts are only included when a transcript actually backs them (source Transcript, not PPT).
 */
export function buildClaims(report, { transcriptAvailable = true } = {}) {
  const claims = [];
  const c = report.concall || {};
  const a = report.about || {};

  (c.guidance || []).forEach((g, i) => {
    if (g.source !== "Transcript") return; // only audit transcript-sourced guidance
    claims.push({ ref: `guidance[${i}]`, category: "guidance", claim: `${g.metric} (${g.horizon}) — ${g.statement}${g.value ? ` [value: ${g.value}]` : ""}` });
  });

  // expansion_flags carry no source field; they are transcript-derived whenever a transcript exists.
  if (transcriptAvailable) {
    (c.expansion_flags || []).forEach((f, i) => {
      claims.push({ ref: `expansion_flags[${i}]`, category: "expansion_flag", claim: `${f.metric}: yoy ${f.yoy_delta ?? "n/a"}, qoq ${f.qoq_delta ?? "n/a"} — driver: ${f.driver}` });
    });
    (a.revenue_mix || []).forEach((r, i) => {
      claims.push({ ref: `about.revenue_mix[${i}]`, category: "about", claim: `Revenue mix: ${r.segment} ≈ ${r.pct}%` });
    });
    (a.margin_by_segment || []).forEach((r, i) => {
      claims.push({ ref: `about.margin_by_segment[${i}]`, category: "about", claim: `Segment EBITDA margin: ${r.segment} = ${r.ebitda_margin}` });
    });
  }
  return claims;
}

/** Build the [system, user] messages for the verifier. Bias toward "partial" when unsure. */
export function buildVerifyMessages(report, transcript, claims) {
  const m = report.meta || {};
  const system = [
    `You are an independent auditor. You are given an earnings-call TRANSCRIPT and a list of CLAIMS a first model extracted from it. For EACH claim, decide whether the transcript supports it. Return ONLY JSON matching the provided schema — one verdict per claim, echoing its exact "ref".`,
    ``,
    `VERDICTS`,
    `- "supported": the transcript clearly states this (numbers/direction match).`,
    `- "partial": the transcript touches it but the specifics differ, are vaguer, or you are not fully sure.`,
    `- "unsupported": the claim is clearly NOT in the transcript, or the transcript contradicts it. Use this ONLY when you are confident it is absent/contradicted — it will cause the claim to be dropped.`,
    `- confidence: high / medium / low. Be conservative: if in doubt, prefer "partial", not "unsupported".`,
    `- note: one line pointing to the transcript basis (or its absence). Do not use outside knowledge — judge ONLY against the transcript text.`,
  ].join("\n");

  const user = [
    `COMPANY: ${m.company || "?"} (${m.ticker || "?"})   QUARTER: ${m.quarter || "?"}`,
    ``,
    `=== TRANSCRIPT ===`,
    nonEmpty(transcript) ? transcript : "(none)",
    ``,
    `=== CLAIMS TO VERIFY (return exactly one verdict per ref) ===`,
    claims.map((c) => `${c.ref} [${c.category}] ${c.claim}`).join("\n"),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Apply the verifier's verdicts. Conservatively DROPS a claim only when the verdict is "unsupported"
 * with non-low confidence (a clear hallucination); everything else is kept. Returns
 *   { report: prunedReport, audit } — audit is the verification.json payload (ALL verdicts logged).
 * `report` is not mutated.
 */
export function applyVerification(report, verifierOut, { model, provider, transcriptAvailable = true } = {}) {
  const verdicts = (verifierOut?.verdicts || []).map((v) => ({ ...v }));
  const byRef = new Map(verdicts.map((v) => [v.ref, v]));

  const shouldDrop = (ref) => {
    const v = byRef.get(ref);
    return !!v && v.verdict === "unsupported" && v.confidence !== "low";
  };

  const out = JSON.parse(JSON.stringify(report)); // deep copy — never mutate the input
  const c = out.concall || {};
  const a = out.about || {};
  const dropped = [];

  // Prune array elements by original index (filter with the original ref, which encodes the index).
  const prune = (list, refFor, category) =>
    (list || []).filter((el, i) => {
      const ref = refFor(i);
      if (shouldDrop(ref)) {
        const v = byRef.get(ref);
        dropped.push({ ref, category, note: v?.note || "", claim: v?.claim || "" });
        return false;
      }
      return true;
    });

  c.guidance = prune(c.guidance, (i) => `guidance[${i}]`, "guidance");
  if (transcriptAvailable) {
    c.expansion_flags = prune(c.expansion_flags, (i) => `expansion_flags[${i}]`, "expansion_flag");
    a.revenue_mix = prune(a.revenue_mix, (i) => `about.revenue_mix[${i}]`, "about");
    a.margin_by_segment = prune(a.margin_by_segment, (i) => `about.margin_by_segment[${i}]`, "about");
  }

  const tally = { supported: 0, partial: 0, unsupported: 0 };
  verdicts.forEach((v) => { if (tally[v.verdict] != null) tally[v.verdict]++; });

  const droppedRefs = new Set(dropped.map((d) => d.ref));
  const audit = {
    slug: out.meta?.slug || null,
    company: out.meta?.company || null,
    quarter: out.meta?.quarter || null,
    generated_at: out.meta?.generated_at || null,
    provider: provider || null,
    model: model || null,
    transcript_available: !!transcriptAvailable,
    checked: verdicts.length,
    tally,
    dropped,
    verdicts: verdicts.map((v) => ({ ...v, dropped: droppedRefs.has(v.ref) })),
  };

  return { report: out, audit };
}
