// research-assemble.mjs — PURE functions (no network) for Step 8's C.6 risks + Section D
// thesis / anti-thesis: build the LLM messages from a Step-7 report + web context, merge the
// result into report.json (source-tagged, falsifier-enforced), and validate those slices against
// report.schema.json. Deterministic and unit-testable without any LLM call.

import { validate } from "./validate.mjs";
import { RISK_TYPES } from "./research-schema.mjs";

const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

/** Build the [system, user] chat messages for the risk + thesis extraction. */
export function buildRiskThesisMessages(report, web, { } = {}) {
  const m = report.meta || {};
  const a = report.about || {};
  const sector = `${a.sector || "?"} / ${a.sub_sector || "?"}`;
  const onCallRisks = (report.concall?.themes || [])
    .filter((t) => t.stance === "Negative")
    .map((t) => `- ${t.theme}: ${t.evidence}`)
    .join("\n") || "(none flagged on the call)";

  const system = [
    `You are a skeptical Indian-equities risk analyst. Produce (1) OFF-CALL risks and (2) a falsifiable bull/bear thesis for ${m.company || "the company"} (${m.ticker || "?"}), ${sector}. Return ONLY JSON matching the provided schema.`,
    ``,
    `GLOBAL RULES`,
    `- Ground every external claim in the WEB FINDINGS provided below. Do NOT invent facts, cases, orders, or ratings. If the findings don't support a risk, omit it.`,
    `- Prefer specificity (dates, amounts, order numbers, agency names) over vague statements.`,
    ``,
    `RISKS (C.6) — risks NOT volunteered on the call. Look specifically for: pending litigation, regulatory/SEBI overhang, promoter pledge or stake changes, related-party flags, and credit-rating actions. Do NOT restate the negative themes management already discussed on the call (listed below).`,
    `- Each risk: a one-line description that ENDS WITH a real citation in the form "(Source: <URL>)" taken from the web findings; and a type from: ${RISK_TYPES.join(", ")} (or a close category).`,
    `- If the web findings genuinely surface nothing, return an EMPTY risks array. Never fabricate a risk to fill space.`,
    ``,
    `THESIS / ANTI-THESIS (Section D) — 3 to 5 points each, structural (not this-quarter noise).`,
    `- thesis: durable growth/margin drivers. anti_thesis: durable risks (demand, new entrants, regulatory, balance sheet, execution).`,
    `- EVERY point MUST carry a falsifier: a SPECIFIC metric or event that would prove it wrong (e.g. "EBITDA margin stays below 22% through FY27" or "a competitor commissions >50kt capacity by FY27"). A narrative restatement is NOT a falsifier.`,
    `- source: "Web" when the point leans on the findings; "Est." when it is your structural inference. A point with no genuine falsifier will be discarded — so give a real one.`,
    ``,
    `RISKS MANAGEMENT ALREADY DISCUSSED (do not repeat as C.6 web risks):`,
    onCallRisks,
  ].join("\n");

  const user = [
    `COMPANY: ${m.company || "?"} (${m.ticker || "?"})   SECTOR: ${sector}   QUARTER: ${m.quarter || "?"}`,
    `Products: ${(a.products || []).join(", ") || "?"}`,
    `Segments: ${(a.segments || []).join(", ") || "?"}`,
    ``,
    `=== WEB FINDINGS (your only source for external facts; each block lists its SOURCES) ===`,
    web && nonEmpty(web.context) ? web.context : "(no web findings returned — you may still give Est.-sourced thesis points, but return an EMPTY risks array)",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Merge the extracted risks + thesis + anti-thesis into report.json. Injects source="Web" on every
 * risk; keeps each thesis/anti point's Web/Est. source; and ENFORCES a non-empty falsifier — any
 * point without one is dropped (recorded in `warnings`). Returns { report, warnings, dropped }.
 */
/** Pull a trailing "(Source: <URL>)" citation out of a risk string → { text, url }. The prompt asks
 *  the model to end each risk with this, so we lift the URL into source_url (clickable) and clean the
 *  displayed text. The cleaned claim doubles as the deep-link target for the web page. */
export function splitCitation(s) {
  const str = String(s || "").trim();
  const m = str.match(/\s*[([]?\s*(?:source|src)\s*[:\-]\s*(https?:\/\/[^\s)\]]+)\s*[)\]]?\s*$/i);
  if (!m) return { text: str, url: null };
  return { text: str.slice(0, m.index).trim().replace(/[\s—–,;-]+$/, ""), url: m[1] };
}

export function assembleResearch(report, llm, { generated_at } = {}) {
  const out = { ...(report || {}) };
  out.concall = { ...(report?.concall || {}) };
  const warnings = [];
  const dropped = [];

  out.concall.risks = (llm.risks || []).map((r) => {
    const { text, url } = splitCitation(r.risk);
    return { risk: text, type: r.type, source: "Web", source_url: url, quote: text || null };
  });

  const takePoints = (list, label) =>
    (list || [])
      .map((p) => ({ point: p.point, falsifier: p.falsifier, source: p.source === "Web" ? "Web" : "Est." }))
      .filter((p) => {
        if (nonEmpty(p.falsifier) && nonEmpty(p.point)) return true;
        dropped.push({ section: label, point: p.point || "(empty)" });
        warnings.push(`${label}: dropped a point with no falsifier — "${(p.point || "").slice(0, 60)}"`);
        return false;
      });

  out.thesis = takePoints(llm.thesis, "thesis");
  out.anti_thesis = takePoints(llm.anti_thesis, "anti_thesis");

  if (generated_at && out.meta) out.meta = { ...out.meta, generated_at };
  return { report: out, warnings, dropped };
}

/**
 * Validate the C.6 + D slices against report.schema.json. Returns { ok, errors, warnings }.
 * Also asserts the invariant the schema can't express: every D point has a non-empty falsifier.
 */
export function validateResearch(report, reportSchema) {
  const root = reportSchema;
  const errors = [
    ...validate(root.properties.concall.properties.risks, report.concall.risks, root, {}, "concall.risks"),
    ...validate(root.properties.thesis, report.thesis, root, {}, "thesis"),
    ...validate(root.properties.anti_thesis, report.anti_thesis, root, {}, "anti_thesis"),
  ];
  const warnings = [];
  for (const [sec, list] of [["thesis", report.thesis], ["anti_thesis", report.anti_thesis]]) {
    (list || []).forEach((p, i) => {
      if (!nonEmpty(p.falsifier)) errors.push(`${sec}[${i}]: empty falsifier (every D point must be falsifiable)`);
    });
    if (!(list || []).length) warnings.push(`${sec}: empty (no points survived) — expected 3–5`);
  }
  return { ok: errors.length === 0, errors, warnings };
}
