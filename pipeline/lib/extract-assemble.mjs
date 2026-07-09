// extract-assemble.mjs — PURE functions (no network): build the LLM messages, assemble the
// extracted B + C into report.json, and validate those slices against report.schema.json.
// Deterministic and unit-testable without calling OpenAI.

import { validate } from "./validate.mjs";
import { CLASSIFICATION_TAGS, THESIS_TRIGGERS, THEME_TOPICS } from "./extract-schema.mjs";

/** Build the [system, user] chat messages. `pptOnly` = no transcript → derive C from the PPT. */
export function buildMessages(bundle, transcript, pptText, { pptOnly = false } = {}) {
  const m = bundle.meta || {};
  const system = [
    `You are a meticulous Indian-equities research analyst. Extract STRUCTURED data from an earnings concall for ${m.company || "the company"} (${m.ticker || "?"}), quarter ${m.quarter || "?"}. Return ONLY JSON matching the provided schema.`,
    ``,
    `GLOBAL RULES`,
    `- Extract only what the provided documents SUPPORT. Never invent, never carry prior-quarter guidance forward, never use outside knowledge.`,
    `- Empty array where nothing applies. For an undisclosed segment EBITDA margin, return null (never guess a number).`,
    `- Evidence must be PARAPHRASED in your own words (not verbatim quotes) and grounded in the call.`,
    ``,
    `SECTION B (about) — you MAY use the transcript AND the investor PPT (transcript first, PPT to fill gaps):`,
    `- products; segments; segment_reported (true only if the company reports segment splits);`,
    `- revenue_mix [{segment, pct}] — % of revenue per segment (0–100, ~sum 100); omit if not derivable;`,
    `- margin_by_segment [{segment, ebitda_margin}] — segment EBITDA margin %; ebitda_margin=null when not disclosed.`,
    ``,
    pptOnly
      ? `SECTION C (concall) — NO TRANSCRIPT IS AVAILABLE. Derive C from the PPT; be conservative and prefer empty over speculation.`
      : `SECTION C (concall) — use the TRANSCRIPT ONLY. Do NOT use the PPT for Section C.`,
    `- guidance (C.1): ONLY forward statements management made ON THIS CALL (not reiterated prior guidance). Each: metric, horizon (FY27/FY28/…), statement (paraphrase), type='hard' (a number/range/target) or 'directional' (words only), value (extracted number/range as a string, or null). Cover at least revenue growth, EBITDA margin, capex, and any guided segment targets.`,
    `- themes (C.2): stance (Positive/Negative/Neutral) + paraphrased evidence for each relevant topic: ${THEME_TOPICS.join(", ")}.`,
    `- tone_shift_vs_last_quarter: how tone moved vs the prior call; if you cannot tell from THIS transcript, return exactly "unknown".`,
    `- expansion_flags (C.3): materially-moved metrics — yoy_delta and qoq_delta as strings (e.g. "+18%") or null — plus the STATED driver (mix/pricing/volume/operating leverage/one-off).`,
    `- thesis_triggers (C.4): flag Yes/No/Partial + one-line evidence for EACH of: ${THESIS_TRIGGERS.join(", ")}.`,
    `- classification (C.5): 1–2 tags from EXACTLY this list — ${CLASSIFICATION_TAGS.join(", ")} — each with a justification grounded in the call.`,
    `- management_tone (C.7): per theme, Confident/Neutral/Defensive, anchored to the specific exchange that revealed it.`,
    `- analyst_tone (C.8): hot_themes = topics that drew ≥2 analyst follow-up questions; qa_tenor = skeptical/constructive/perfunctory.`,
    `Do NOT output C.6 risks — handled elsewhere.`,
  ].join("\n");

  const user = [
    `COMPANY: ${m.company || "?"} (${m.ticker || "?"})   QUARTER: ${m.quarter || "?"}   transcript_available=${!pptOnly}`,
    ``,
    `=== TRANSCRIPT ===`,
    transcript && transcript.trim() ? transcript : "(none)",
    ``,
    `=== INVESTOR PPT (Section B only${pptOnly ? "; also the source for Section C in this PPT-only run" : ""}) ===`,
    pptText && pptText.trim() ? pptText : "(none)",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Merge the extracted B + C into report.json. Passes meta + inputs through from the bundle; injects
 * the deterministic `source` on C.1/C.2 (Transcript, or PPT in PPT-only mode); converts a null
 * segment margin to the literal "not disclosed"; leaves C.6 risks [] and the D/E/F/G slices to later steps.
 */
export function assembleReport(existing, bundle, llm, { pptOnly = false, generated_at } = {}) {
  const source = pptOnly ? "PPT" : "Transcript";
  const bm = bundle.meta || {};
  const a = llm.about || {};
  const c = llm.concall || {};

  const about = {
    sector: bm.sector || "Unspecified",
    sub_sector: bm.sub_sector || "Unspecified",
    products: a.products || [],
    segments: a.segments || [],
    segment_reported: !!a.segment_reported,
    revenue_mix: (a.revenue_mix || []).map((r) => ({ segment: r.segment, pct: r.pct })),
    margin_by_segment: (a.margin_by_segment || []).map((r) => ({
      segment: r.segment,
      ebitda_margin: typeof r.ebitda_margin === "number" ? r.ebitda_margin : "not disclosed", // null → verbatim
    })),
  };

  const concall = {
    guidance: (c.guidance || []).map((g) => ({ metric: g.metric, horizon: g.horizon, statement: g.statement, type: g.type, value: g.value ?? null, source })),
    themes: (c.themes || []).map((t) => ({ theme: t.theme, stance: t.stance, evidence: t.evidence, source })),
    tone_shift_vs_last_quarter: c.tone_shift_vs_last_quarter || "unknown",
    expansion_flags: (c.expansion_flags || []).map((f) => ({ metric: f.metric, yoy_delta: f.yoy_delta ?? null, qoq_delta: f.qoq_delta ?? null, driver: f.driver })),
    thesis_triggers: (c.thesis_triggers || []).map((t) => ({ trigger: t.trigger, flag: t.flag, evidence: t.evidence })),
    classification: (c.classification || []).map((t) => ({ tag: t.tag, justification: t.justification })),
    risks: [], // C.6 — web-sourced, Step 8
    management_tone: (c.management_tone || []).map((t) => ({ theme: t.theme, tone: t.tone, anchor: t.anchor })),
    analyst_tone: { hot_themes: c.analyst_tone?.hot_themes || [], qa_tenor: c.analyst_tone?.qa_tenor || "perfunctory" },
  };

  const report = { ...(existing || {}) };
  report.meta = {
    company: bm.company,
    ticker: bm.ticker,
    slug: bm.slug,
    quarter: bm.quarter,
    quarter_confirmed: !!bm.quarter_confirmed,
    generated_at: generated_at || null,
    transcript_available: !!bm.transcript_available,
    sources: {
      transcript_url: bundle.sources?.transcript_url ?? null,
      ppt_url: bundle.sources?.ppt_url ?? null,
      concall_date: bundle.sources?.concall_date ?? null,
    },
    inputs: { ...(bundle.inputs || {}) },
  };
  report.about = about;
  report.concall = concall;
  if (!Array.isArray(report.key_takeaways)) report.key_takeaways = []; // Step 9
  if (!Array.isArray(report.thesis)) report.thesis = []; // Step 8
  if (!Array.isArray(report.anti_thesis)) report.anti_thesis = []; // Step 8
  return report;
}

/**
 * Validate the B (about) and C (concall) slices against report.schema.json. Permits the one
 * documented exception: margin_by_segment.ebitda_margin may be the string "not disclosed"
 * (the schema says number; see pipeline/VALIDATION-TODO.md). Returns { ok, errors, warnings }.
 */
export function validateBC(report, reportSchema) {
  const root = reportSchema;
  // Validate a copy where "not disclosed" margins are coerced to a number, so the rest is strict.
  const aboutForVal = JSON.parse(JSON.stringify(report.about));
  const warnings = [];
  aboutForVal.margin_by_segment = (aboutForVal.margin_by_segment || []).map((m) => {
    if (typeof m.ebitda_margin !== "number") {
      warnings.push(`about.margin_by_segment "${m.segment}": ${JSON.stringify(m.ebitda_margin)} (undisclosed — allowed exception)`);
      return { ...m, ebitda_margin: 0 };
    }
    return m;
  });

  const errors = [
    ...validate(root.properties.about, aboutForVal, root, {}, "about"),
    ...validate(root.properties.concall, report.concall, root, {}, "concall"),
  ];
  return { ok: errors.length === 0, errors, warnings };
}
