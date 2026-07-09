// model-assemble.mjs — PURE functions (no network) for Step 9's E (financial model), F (valuation),
// G (next steps) and the final key_takeaways synthesis. Builds the LLM messages, assembles the
// deterministic rows/multiples, and validates the completed report end-to-end against
// report.schema.json. Unit-testable without any LLM call; the arithmetic mirrors the frontend.

import { validate } from "./validate.mjs";
import {
  computeForecast, computeValuation, guidedFor, deriveMonitorables, assessValuationRichness, buildSanityCheck, round1, round2,
} from "./model.mjs";

const numOr = (v, fb = null) => (typeof v === "number" && isFinite(v) ? v : fb);
const clampArr = (a, lo, hi) => { const x = Array.isArray(a) ? a.slice(0, hi) : []; return { list: x, short: x.length < lo }; };

// ── E/F/G model call ─────────────────────────────────────────────────────────

/** Build the [system, user] messages for the model call (assumptions + prose only; script does math). */
export function buildModelMessages(report, fy26a, ctx, { } = {}) {
  const m = report.meta || {};
  const g = report.concall?.guidance || [];
  const guidanceLines = g.map((x) => `- ${x.metric} (${x.horizon}) [${x.source}]: ${x.statement}${x.value ? ` — ${x.value}` : ""}`).join("\n") || "(none)";
  const thesisLines = (report.thesis || []).map((p) => `+ ${p.point}`).join("\n") || "(none)";
  const antiLines = (report.anti_thesis || []).map((p) => `- ${p.point}`).join("\n") || "(none)";

  const system = [
    `You are an Indian-equities analyst building a 2-year forward model for ${m.company || "the company"} (${m.ticker || "?"}). Return ONLY JSON matching the schema. You supply ASSUMPTIONS (growth %, margin %) and PROSE; a deterministic script computes every rupee figure and every multiple — so give clean percentage levers, not absolute numbers.`,
    ``,
    `ASSUMPTIONS RULE (critical):`,
    `- Where management gave EXPLICIT guidance on the call (see C.1 below), USE THAT NUMBER and say so in the *_basis (it will be tagged "mgmt guidance").`,
    `- Where no guidance exists, make a reasoned DIRECTIONAL estimate and say so (tagged "Est."). Never fabricate precision — an Est. is a directional view the user can change first.`,
    `- revenue_growth (%): FY27 and FY28 YoY. ebitda_margin / net_margin (%): FY27 and FY28. gross_margin (%): estimate ONLY if commentary supports it, else null (Screener does not report it).`,
    `- adj_ebitda: set reports_adj_ebitda=true and fill the adj margins ONLY if the company reports/emphasises Adjusted EBITDA as a KPI; otherwise false + nulls.`,
    ``,
    `DRIVERS: one line each. Revenue: volume / pricing / new capacity / demand. Margins: the expansion or contraction lever, and whether it is sustainable.`,
    ``,
    `G — conviction: weigh thesis vs anti-thesis vs valuation. Buy-watch / Hold-watch / Avoid-watch. conviction_note frames it as a research OBSERVATION, not advice. rerating_triggers: what would move the multiple, synthesised from the thesis + guidance.`,
    `assumptions_note: what breaks the model; explicitly say the Est. values are a directional view to change first if the user disagrees.`,
  ].join("\n");

  const user = [
    `COMPANY: ${m.company} (${m.ticker})   QUARTER: ${m.quarter}`,
    `FY26A (₹cr): revenue ${numOr(fy26a.revenue, "?")}, EBITDA ${numOr(fy26a.ebitda, "?")} (margin ${numOr(fy26a.ebitda_margin_pct, "?")}%), PAT ${numOr(fy26a.pat, "?")} (net margin ${numOr(fy26a.net_margin_pct, "?")}%), gross margin ${fy26a.gross_margin_pct == null ? "not reported" : fy26a.gross_margin_pct + "%"}`,
    `Price inputs: CMP ₹${m.inputs?.cmp}, shares ${m.inputs?.shares_out_cr}cr, net debt ₹${m.inputs?.net_debt_cr}cr`,
    ctx ? `Valuation context (Screener): current P/E ${numOr(ctx.current_pe, "n/a")}, 5-yr median P/E ${numOr(ctx.hist_median_pe, "n/a")}, peer median P/E ${numOr(ctx.peer_median_pe, "n/a")}` : `Valuation context: unavailable`,
    ``,
    `C.1 GUIDANCE (use these numbers where present):`,
    guidanceLines,
    ``,
    `THESIS:\n${thesisLines}`,
    `ANTI-THESIS:\n${antiLines}`,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Assemble E + F + G into the report. The SCRIPT computes every number deterministically from FY26A +
 * the LLM's percentage levers (same formulas as the frontend), tags each assumption mgmt-guidance/Est.,
 * builds the valuation multiples + a real "vs history/peers" sanity-check, and derives monitorables
 * from C.1 guidance. Returns { report, warnings, richness, valuationInternal }.
 */
export function assembleModel(report, fy26a, llm, ctx, { generated_at, positiveTone } = {}) {
  const out = { ...(report || {}) };
  const warnings = [];

  // Levers, stored at the SAME rounding used to compute valuation → seedEdits/computeModel reproduce it.
  const lev = {
    growth_fy27: round2(llm.revenue_growth_fy27), growth_fy28: round2(llm.revenue_growth_fy28),
    ebitda_margin_fy27: round1(llm.ebitda_margin_fy27), ebitda_margin_fy28: round1(llm.ebitda_margin_fy28),
    net_margin_fy27: round1(llm.net_margin_fy27), net_margin_fy28: round1(llm.net_margin_fy28),
    gross_margin_fy27: llm.gross_margin_fy27 == null ? null : round1(llm.gross_margin_fy27),
    gross_margin_fy28: llm.gross_margin_fy28 == null ? null : round1(llm.gross_margin_fy28),
  };
  const f = computeForecast(fy26a, lev);

  // Build the rows in the schema's conventional order. Absolutes → round0 for storage (frontend
  // display-rounds anyway); margins → round1; gross margin nullable.
  const r0 = (v) => (v == null ? null : Math.round(v));
  const row = (key, metric, unit, vals, driver) => ({ key, metric, unit, fy26a: vals.fy26a ?? null, fy27e: vals.fy27e ?? null, fy28e: vals.fy28e ?? null, driver });
  const absVals = (o) => ({ fy26a: r0(o.fy26a), fy27e: r0(o.fy27e), fy28e: r0(o.fy28e) });
  const pctVals = (o) => ({ fy26a: round1(o.fy26a), fy27e: round1(o.fy27e), fy28e: round1(o.fy28e) });

  const rows = [
    row("revenue", "Revenue", "rs_cr", absVals(f.revenue), llm.driver_revenue),
    row("gross_margin_pct", "Gross margin %", "pct", pctVals(f.gross_margin_pct), llm.driver_gross_margin),
    row("ebitda", "EBITDA", "rs_cr", absVals(f.ebitda), llm.driver_ebitda),
    row("ebitda_margin_pct", "EBITDA margin %", "pct", pctVals(f.ebitda_margin_pct), llm.driver_ebitda_margin),
  ];
  if (llm.reports_adj_ebitda) {
    rows.push(row("adj_ebitda_margin_pct", "Adjusted EBITDA margin %", "pct",
      pctVals({ fy26a: llm.adj_ebitda_margin_fy26, fy27e: llm.adj_ebitda_margin_fy27, fy28e: llm.adj_ebitda_margin_fy28 }), llm.driver_adj_ebitda));
  }
  rows.push(row("pat", "PAT", "rs_cr", absVals(f.pat), llm.driver_pat));
  rows.push(row("net_margin_pct", "Net margin %", "pct", pctVals(f.net_margin_pct), llm.driver_net_margin));

  const tag = (guided) => (guided ? "mgmt guidance" : "Est.");
  const growthGuided = guidedFor(report, ["revenue", "growth"]);
  const marginGuided = guidedFor(report, ["ebitda", "margin"]);
  const assumptions = {
    revenue_growth: { fy27: lev.growth_fy27, fy28: lev.growth_fy28, basis: `${tag(growthGuided)} — ${llm.revenue_growth_basis}` },
    margin: { fy27: lev.ebitda_margin_fy27, fy28: lev.ebitda_margin_fy28, basis: `${tag(marginGuided)} — ${llm.margin_basis}` },
    note: `${llm.assumptions_note}${/directional/i.test(llm.assumptions_note) ? "" : " Est. values are a directional view — change them first if you disagree."}`,
  };
  out.financials = { rows, assumptions };

  // F — valuation from the SAME stored levers (exact reconciliation with the frontend on load).
  const v = computeValuation(out.meta?.inputs || {}, f);
  const richness = assessValuationRichness(v.pe.fy27e, ctx || {});
  const sanity = buildSanityCheck({ valuation: v, inputs: out.meta?.inputs || {}, currentPe: ctx ? numOr(ctx.current_pe) : null, richness, positiveTone: !!positiveTone });
  out.valuation = { pe: v.pe, ev_ebitda: v.ev_ebitda, price_sales: v.price_sales, sanity_check: sanity };
  if (v.pe.fy27e == null || v.ev_ebitda.fy27e == null) warnings.push("a FY27E multiple is n.m. (denominator ≤ 0) — full-report validation will fail; the company may be loss-making");

  // G — next steps.
  out.next_steps = {
    monitorables: deriveMonitorables(report),
    rerating_triggers: Array.isArray(llm.rerating_triggers) ? llm.rerating_triggers : [],
    conviction: llm.conviction,
    conviction_note: llm.conviction_note,
  };

  if (generated_at && out.meta) out.meta = { ...out.meta, generated_at };
  return { report: out, warnings, richness, valuationInternal: v };
}

/** Validate the E/F/G slices against report.schema.json. Returns { ok, errors }. */
export function validateEFG(report, reportSchema) {
  const root = reportSchema;
  const errors = [
    ...validate(root.properties.financials, report.financials, root, {}, "financials"),
    ...validate(root.properties.valuation, report.valuation, root, {}, "valuation"),
    ...validate(root.properties.next_steps, report.next_steps, root, {}, "next_steps"),
  ];
  // one-row-per-key (the schema blocks exact dupes but not two rows sharing a key)
  const keys = (report.financials?.rows || []).map((r) => r.key);
  const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dupe) errors.push(`financials.rows: duplicate key "${dupe}" (one row per key)`);
  return { ok: errors.length === 0, errors };
}

// ── finalize: key_takeaways synthesis ────────────────────────────────────────

/** Build the [system, user] messages for the final key_takeaways synthesis across B–G. */
export function buildFinalizeMessages(report) {
  const m = report.meta || {};
  const v = report.valuation || {};
  const ns = report.next_steps || {};
  const guidance = (report.concall?.guidance || []).map((g) => `${g.metric}: ${g.value || g.statement}`).join("; ");
  const system = [
    `You are writing the tl;dr an analyst reads first for ${m.company || "the company"} (${m.ticker || "?"}), ${m.quarter || ""}. Return ONLY JSON: 5 to 7 crisp, scannable bullets — the single most decision-relevant points across the whole report (B–G).`,
    `Cover, in one line each where relevant: the core thesis, the guidance that matters, the growth/margin trajectory, the valuation read (cite a multiple), and the verdict. No preamble, no repetition, no hedging filler.`,
  ].join("\n");
  const user = [
    `Sector: ${report.about?.sector} / ${report.about?.sub_sector}`,
    `Guidance: ${guidance || "(none)"}`,
    `Thesis: ${(report.thesis || []).map((p) => p.point).join(" | ") || "(none)"}`,
    `Anti-thesis: ${(report.anti_thesis || []).map((p) => p.point).join(" | ") || "(none)"}`,
    `Valuation: FY27E P/E ${v.pe?.fy27e ?? "?"}x, FY28E ${v.pe?.fy28e ?? "?"}x. ${v.sanity_check || ""}`,
    `Conviction: ${ns.conviction} — ${ns.conviction_note || ""}`,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Set report.key_takeaways from the synthesis (clamped to ≤7; warns if <5). Returns { report, warnings }. */
export function assembleKeyTakeaways(report, llm) {
  const { list, short } = clampArr(llm.key_takeaways, 5, 7);
  const warnings = short ? [`key_takeaways: only ${list.length} returned (< 5 expected)`] : [];
  return { report: { ...report, key_takeaways: list }, warnings };
}

/**
 * Drop internal pipeline metadata (top-level keys starting with "_", e.g. _step7/_step8_research)
 * that earlier steps stapled onto report.json. The final report must be schema-clean, and the root
 * schema is additionalProperties:false — so these are removed before the end-to-end validation + write.
 */
export function stripInternal(report) {
  const out = {};
  for (const k of Object.keys(report || {})) if (!k.startsWith("_")) out[k] = report[k];
  return out;
}

/** Validate the WHOLE report end-to-end against report.schema.json (root). Returns { ok, errors }. */
export function validateFull(report, reportSchema) {
  const errors = validate(reportSchema, report, reportSchema, {}, "$");
  return { ok: errors.length === 0, errors };
}
