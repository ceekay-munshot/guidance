// export.js — STEP 12: branded client-side PDF + Excel export of the open report.
//
// Exports run ENTIRELY in the browser from the loaded report.json — no backend, no schema change.
// Libraries load on demand from unpkg (this network blocks jsdelivr):
//   • PDF   → jsPDF (UMD) + jspdf-autotable          → a packed, institutional research note
//   • Excel → ExcelJS (UMD), CSV fallback if it fails → a colour-graded multi-sheet workbook
//
// Design: the DATA layer (reportContent + buildPdfModel/buildWorkbookModel/buildCsv/exportFilename)
// is PURE and DOM-free, so it unit-tests in Node against sample-report.json + a PPT-only fixture.
// The RENDER layer (renderPdf/renderWorkbook) is the only part that touches the CDN libs and the DOM.
// Every field is guarded (missing / null safe); the PDF additionally sanitises non-Latin-1 glyphs
// (₹, arrows) that jsPDF's core fonts can't draw.

// ── brand palette (STEP 12 spec) ─────────────────────────────────────────────
export const BRAND = {
  indigo: "#6366F1", violet: "#A855F7", magenta: "#EC4899",
  ink: "#1E293B", muted: "#64748B",
  tintIndigo: "#EEF2FF", tintViolet: "#F5F3FF",
  buy: "#059669", hold: "#F59E0B", avoid: "#EF4444",
  hair: "#E6E8F0", white: "#FFFFFF",
};
export const DISCLAIMER = "Research observation, not investment advice — not a SEBI-registered recommendation.";

const UNPKG = {
  jspdf: "https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js",
  autotable: "https://unpkg.com/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js",
  exceljs: "https://unpkg.com/exceljs@4.4.0/dist/exceljs.min.js",
};

// ── colour helpers for the two libs ──────────────────────────────────────────
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const argb = (hex) => "FF" + hex.slice(1).toUpperCase();

// ── guards + formatters ──────────────────────────────────────────────────────
const isNum = (v) => typeof v === "number" && isFinite(v);
const S = (v) => (v === null || v === undefined ? "" : String(v));
const dash = (v) => { const s = S(v).trim(); return s === "" ? "—" : s; };
const arr = (v) => (Array.isArray(v) ? v : []);

const crStr = (v) => (isNum(v) ? "Rs " + Math.round(v).toLocaleString("en-IN") + " cr" : "—");
const moneyStr = (v) => (isNum(v) ? "Rs " + Math.round(v).toLocaleString("en-IN") : "—");
const crNum = (v) => (isNum(v) ? Math.round(v).toLocaleString("en-IN") : "—");
const pctStr = (v) => (isNum(v) ? v.toFixed(1) + "%" : "—");
const multStr = (v) => (isNum(v) ? v.toFixed(1) + "x" : "n.m.");
const cellByUnit = (unit, v) => (unit === "pct" ? pctStr(v) : crNum(v));

/** Format an ISO timestamp as a readable date (e.g. "09 Jul 2026"); never throws. */
export function fmtDate(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${String(d.getUTCDate()).padStart(2, "0")} ${mon} ${d.getUTCFullYear()}`;
}

/** Replace glyphs jsPDF's WinAnsi core fonts can't draw so the PDF never shows tofu boxes. */
function pdfSafe(v) {
  return S(v)
    .replace(/₹/g, "Rs ")   // ₹ (not in WinAnsi)
    .replace(/[Δδ]/g, "delta ") // Δ (Greek delta — not in WinAnsi; would tofu)
    .replace(/→/g, "->").replace(/←/g, "<-")
    .replace(/↑/g, "up ").replace(/↓/g, "down ")
    .replace(/•/g, "-");    // • → -
}

const convictionColor = (c) =>
  c === "Buy-watch" ? BRAND.buy : c === "Hold-watch" ? BRAND.hold : c === "Avoid-watch" ? BRAND.avoid : BRAND.muted;
const stanceColor = (s) => (s === "Positive" ? BRAND.buy : s === "Negative" ? BRAND.avoid : BRAND.muted);
const flagColor = (f) => (f === "Yes" ? BRAND.buy : f === "Partial" ? BRAND.hold : BRAND.muted);
const toneColor = (t) => (t === "Confident" ? BRAND.buy : t === "Defensive" ? BRAND.hold : BRAND.muted);

// ── filename ─────────────────────────────────────────────────────────────────
/** Munshot-ConcallDeepDive-<TICKER>-<QUARTER>.<ext> — always a safe, non-empty name. */
export function exportFilename(report, ext) {
  const m = (report && report.meta) || {};
  const ticker = S(m.ticker || m.slug || "report").toUpperCase().replace(/[^A-Z0-9]+/g, "") || "REPORT";
  const quarter = S(m.quarter).replace(/[^A-Za-z0-9]+/g, "") || "Latest";
  return `Munshot-ConcallDeepDive-${ticker}-${quarter}.${ext}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// PURE DATA LAYER — normalise the report into guarded, render-ready content.
// ══════════════════════════════════════════════════════════════════════════════
/**
 * The single, guarded intermediate both exporters read. Raw values are preserved (numbers stay
 * numbers so Excel can number-format + right-align them); the PDF formats to strings at render time.
 */
export function reportContent(report) {
  const r = report || {};
  const m = r.meta || {};
  const i = m.inputs || {};
  const about = r.about || {};
  const concall = r.concall || {};
  const fin = r.financials || {};
  const val = r.valuation || {};
  const ns = r.next_steps || {};
  return {
    company: dash(m.company),
    ticker: dash(m.ticker),
    quarter: dash(m.quarter),
    quarterConfirmed: m.quarter_confirmed !== false,
    concallDate: m.sources && m.sources.concall_date ? S(m.sources.concall_date) : "—",
    generatedAt: m.generated_at || null,
    transcriptAvailable: m.transcript_available !== false,
    inputs: {
      cmp: i.cmp, market_cap_cr: i.market_cap_cr, net_debt_cr: i.net_debt_cr,
      shares_out_cr: i.shares_out_cr, cmp_date: i.cmp_date,
    },
    takeaways: arr(r.key_takeaways).map(S),
    about: {
      sector: dash(about.sector), subSector: dash(about.sub_sector),
      products: arr(about.products).map(S),
      segments: arr(about.segments).map(S),
      segmentReported: about.segment_reported !== false,
      revenueMix: arr(about.revenue_mix).map((x) => ({ segment: S(x && x.segment), pct: x && x.pct })),
      marginBySegment: arr(about.margin_by_segment).map((x) => ({ segment: S(x && x.segment), margin: x && x.ebitda_margin })),
    },
    guidance: arr(concall.guidance).map((g) => ({
      metric: S(g && g.metric), horizon: S(g && g.horizon), statement: S(g && g.statement),
      type: S(g && g.type), value: g && g.value != null ? S(g.value) : "", source: S(g && g.source),
    })),
    themes: arr(concall.themes).map((t) => ({ theme: S(t && t.theme), stance: S(t && t.stance), evidence: S(t && t.evidence), source: S(t && t.source) })),
    toneShift: S(concall.tone_shift_vs_last_quarter),
    expansion: arr(concall.expansion_flags).map((f) => ({ metric: S(f && f.metric), yoy: f && f.yoy_delta != null ? S(f.yoy_delta) : "—", qoq: f && f.qoq_delta != null ? S(f.qoq_delta) : "—", driver: S(f && f.driver) })),
    triggers: arr(concall.thesis_triggers).map((t) => ({ trigger: S(t && t.trigger), flag: S(t && t.flag), evidence: S(t && t.evidence) })),
    classification: arr(concall.classification).map((c) => ({ tag: S(c && c.tag), justification: S(c && c.justification) })),
    risks: arr(concall.risks).map((x) => ({ risk: S(x && x.risk), type: S(x && x.type), source: S(x && x.source) })),
    mgmtTone: arr(concall.management_tone).map((t) => ({ theme: S(t && t.theme), tone: S(t && t.tone), anchor: S(t && t.anchor) })),
    analystTone: { hot: arr(concall.analyst_tone && concall.analyst_tone.hot_themes).map(S), tenor: S(concall.analyst_tone && concall.analyst_tone.qa_tenor) },
    thesis: arr(r.thesis).map((t) => ({ point: S(t && t.point), falsifier: S(t && t.falsifier), source: S(t && t.source) })),
    antiThesis: arr(r.anti_thesis).map((t) => ({ point: S(t && t.point), falsifier: S(t && t.falsifier), source: S(t && t.source) })),
    model: {
      rows: arr(fin.rows).map((x) => ({ key: S(x && x.key), metric: S(x && x.metric), unit: S(x && x.unit), fy26a: x && x.fy26a, fy27e: x && x.fy27e, fy28e: x && x.fy28e, driver: S(x && x.driver) })),
      growth: { fy27: fin.assumptions && fin.assumptions.revenue_growth && fin.assumptions.revenue_growth.fy27, fy28: fin.assumptions && fin.assumptions.revenue_growth && fin.assumptions.revenue_growth.fy28, basis: S(fin.assumptions && fin.assumptions.revenue_growth && fin.assumptions.revenue_growth.basis) },
      margin: { fy27: fin.assumptions && fin.assumptions.margin && fin.assumptions.margin.fy27, fy28: fin.assumptions && fin.assumptions.margin && fin.assumptions.margin.fy28, basis: S(fin.assumptions && fin.assumptions.margin && fin.assumptions.margin.basis) },
      note: S(fin.assumptions && fin.assumptions.note),
    },
    valuation: {
      pe: { fy27e: val.pe && val.pe.fy27e, fy28e: val.pe && val.pe.fy28e },
      evEbitda: { fy27e: val.ev_ebitda && val.ev_ebitda.fy27e, fy28e: val.ev_ebitda && val.ev_ebitda.fy28e },
      priceSales: { fy27e: val.price_sales && val.price_sales.fy27e, fy28e: val.price_sales && val.price_sales.fy28e },
      sanity: S(val.sanity_check),
    },
    verdict: {
      conviction: S(ns.conviction), note: S(ns.conviction_note),
      monitorables: arr(ns.monitorables).map(S), triggers: arr(ns.rerating_triggers).map(S),
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// PDF MODEL (pure) — a packed, section-by-section spec the renderer walks.
// ══════════════════════════════════════════════════════════════════════════════
/**
 * Build the PDF spec: masthead, snapshot chips, and the A→G sections (already string-formatted &
 * pdf-safe). Section kinds: "bullets" | "table" | "twocol" | "paragraph". Never throws on missing data.
 */
export function buildPdfModel(report) {
  const c = reportContent(report);
  const P = (x) => pdfSafe(x);
  const sections = [];

  // A · Key Takeaways
  sections.push({ kind: "bullets", id: "A", title: "Key Takeaways", items: c.takeaways.map(P) });

  // B · About
  const aboutTables = [];
  if (c.about.revenueMix.length)
    aboutTables.push({ headers: ["Segment", "% of revenue"], colTypes: ["text", "num"], rows: c.about.revenueMix.map((x) => [P(x.segment), pctStr(x.pct)]) });
  if (c.about.marginBySegment.length)
    aboutTables.push({ headers: ["Segment", "EBITDA margin"], colTypes: ["text", "num"], rows: c.about.marginBySegment.map((x) => [P(x.segment), pctStr(x.margin)]) });
  sections.push({
    kind: "about", id: "B", title: "About the Company",
    sector: `${P(c.about.sector)} · ${P(c.about.subSector)}`,
    products: c.about.products.map(P),
    segmentNote: c.about.segmentReported ? "" : "Company does not report segment splits — mix & margins are estimated.",
    tables: aboutTables,
  });

  // C · Concall
  if (c.guidance.length)
    sections.push({ kind: "table", id: "C.1", title: "Guidance", headers: ["Metric", "Horizon", "Statement", "Type", "Source"], colTypes: ["text", "text", "wrap", "tag", "source"], widths: [96, 66, 0, 46, 54], rows: c.guidance.map((g) => [P(g.metric) + (g.value ? `\n(${P(g.value)})` : ""), P(g.horizon), P(g.statement), P(g.type), g.source]) });
  if (c.themes.length)
    sections.push({ kind: "table", id: "C.2", title: "Sector & Theme Commentary", headers: ["Theme", "Stance", "Evidence", "Source"], colTypes: ["text", "stance", "wrap", "source"], widths: [110, 54, 0, 54], rows: c.themes.map((t) => [P(t.theme), t.stance, P(t.evidence), t.source]) });
  if (c.toneShift) sections.push({ kind: "paragraph", id: "C.2b", title: "Tone Shift vs Last Quarter", text: P(c.toneShift) });
  if (c.expansion.length)
    sections.push({ kind: "table", id: "C.3", title: "Margin / Revenue Expansion Flags", headers: ["Metric", "YoY chg", "QoQ chg", "Driver"], colTypes: ["text", "num", "num", "wrap"], widths: [120, 60, 60, 0], rows: c.expansion.map((f) => [P(f.metric), P(f.yoy), P(f.qoq), P(f.driver)]) });
  if (c.triggers.length)
    sections.push({ kind: "table", id: "C.4", title: "Thesis-Trigger Checklist", headers: ["Trigger", "Flag", "Evidence"], colTypes: ["text", "flag", "wrap"], widths: [150, 52, 0], rows: c.triggers.map((t) => [P(t.trigger), t.flag, P(t.evidence)]) });
  if (c.classification.length)
    sections.push({ kind: "table", id: "C.5", title: "Classification", headers: ["Tag", "Why"], colTypes: ["text", "wrap"], widths: [140, 0], rows: c.classification.map((x) => [P(x.tag), P(x.justification)]) });
  if (c.risks.length)
    sections.push({ kind: "table", id: "C.6", title: "Risks", headers: ["Risk", "Type", "Source"], colTypes: ["wrap", "text", "source"], widths: [0, 96, 54], rows: c.risks.map((x) => [P(x.risk), P(x.type), x.source]) });
  if (c.mgmtTone.length)
    sections.push({ kind: "table", id: "C.7", title: "Management Tone", headers: ["Theme", "Tone", "Anchor"], colTypes: ["text", "tone", "wrap"], widths: [130, 66, 0], rows: c.mgmtTone.map((t) => [P(t.theme), t.tone, P(t.anchor)]) });
  if (c.analystTone.hot.length || c.analystTone.tenor)
    sections.push({ kind: "paragraph", id: "C.8", title: "Analyst Tone", text: P(`Q&A tenor: ${dash(c.analystTone.tenor)}. Hot themes: ${c.analystTone.hot.join(", ") || "—"}.`) });

  // D · Thesis vs Anti-thesis — two labelled, colour-headed tables (stacked, packed)
  sections.push({
    kind: "twocol", id: "D", title: "Thesis vs Anti-thesis",
    left: { label: "Thesis", color: BRAND.buy, rows: c.thesis.map((t) => [P(t.point), P(t.falsifier), t.source]) },
    right: { label: "Anti-thesis", color: BRAND.avoid, rows: c.antiThesis.map((t) => [P(t.point), P(t.falsifier), t.source]) },
    headers: ["Point", "Proven wrong if", "Source"], colTypes: ["wrap", "wrap", "source"], widths: [0, 0, 54],
  });

  // E · Financial model
  if (c.model.rows.length)
    sections.push({
      kind: "table", id: "E", title: "Financial Model (Rs Cr / %)", headers: ["Metric", "FY26A", "FY27E", "FY28E", "Driver"],
      colTypes: ["text", "num", "num", "num", "wrap"], widths: [118, 52, 52, 52, 0],
      rows: c.model.rows.map((row) => [P(row.metric), cellByUnit(row.unit, row.fy26a), cellByUnit(row.unit, row.fy27e), cellByUnit(row.unit, row.fy28e), P(row.driver)]),
      footNotes: [c.model.growth.basis && `Growth basis: ${P(c.model.growth.basis)}`, c.model.margin.basis && `Margin basis: ${P(c.model.margin.basis)}`, c.model.note && `Note: ${P(c.model.note)}`].filter(Boolean),
    });

  // F · Valuation
  sections.push({
    kind: "table", id: "F", title: "Valuation", compact: true, headers: ["Multiple", "FY27E", "FY28E"], colTypes: ["text", "num", "num"], widths: [140, 70, 70],
    rows: [
      ["P/E", multStr(c.valuation.pe.fy27e), multStr(c.valuation.pe.fy28e)],
      ["EV/EBITDA", multStr(c.valuation.evEbitda.fy27e), multStr(c.valuation.evEbitda.fy28e)],
      ["P/S", multStr(c.valuation.priceSales.fy27e), multStr(c.valuation.priceSales.fy28e)],
    ],
    footNotes: c.valuation.sanity ? [`Sanity check: ${P(c.valuation.sanity)}`] : [],
  });

  // G · Verdict — boxed conviction panel
  sections.push({
    kind: "verdict", id: "G", title: "Verdict", conviction: dash(c.verdict.conviction), color: convictionColor(c.verdict.conviction),
    note: P(c.verdict.note), monitorables: c.verdict.monitorables.map(P), triggers: c.verdict.triggers.map(P),
  });

  return {
    filename: exportFilename(report, "pdf"),
    masthead: {
      wordmark: "Munshot Concall Deep Dive", preparedFor: "Prepared for MGA",
      company: P(c.company), ticker: P(c.ticker),
      quarter: P(c.quarter) + (c.quarterConfirmed ? "" : " (unconfirmed)"),
      concallDate: P(c.concallDate), generated: fmtDate(c.generatedAt),
      transcriptNote: c.transcriptAvailable ? "" : "PPT-only — no transcript",
    },
    snapshot: [
      { label: "CMP", value: moneyStr(c.inputs.cmp) },
      { label: "Market cap", value: crStr(c.inputs.market_cap_cr) },
      { label: "Net debt", value: crStr(c.inputs.net_debt_cr) },
      { label: "Conviction", value: dash(c.verdict.conviction), color: convictionColor(c.verdict.conviction) },
    ],
    sections,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EXCEL WORKBOOK MODEL (pure) — five colour-graded sheets, raw values + number formats.
// ══════════════════════════════════════════════════════════════════════════════
const NUMFMT = { cr: "#,##0", pct: '0.0"%"', mult: '0.0"x"' };

/** A table block: headers + column meta (numFmt/align/colour) + raw rows. Consumed by renderWorkbook. */
const tbl = (headers, cols, rows) => ({ type: "table", headers, cols, rows });

export function buildWorkbookModel(report) {
  const c = reportContent(report);
  const sub = `${c.company}  ·  ${c.ticker}  ·  ${c.quarter}  ·  Generated ${fmtDate(c.generatedAt)}`;

  // 1 · Summary
  const summary = { name: "Summary", subtitle: sub, blocks: [] };
  summary.blocks.push({ type: "section", title: "Snapshot" });
  summary.blocks.push({
    type: "kv", pairs: [
      ["CMP (Rs)", c.inputs.cmp, "cr"], ["Market cap (Rs Cr)", c.inputs.market_cap_cr, "cr"],
      ["Net debt (Rs Cr)", c.inputs.net_debt_cr, "cr"], ["Shares out (Cr)", c.inputs.shares_out_cr, "cr"],
      ["Quarter", c.quarter + (c.quarterConfirmed ? "" : " (unconfirmed)"), "text"],
      ["Concall date", c.concallDate, "text"], ["Transcript", c.transcriptAvailable ? "Available" : "PPT-only", "text"],
    ],
  });
  summary.blocks.push({ type: "section", title: "Key Takeaways" });
  summary.blocks.push({ type: "bullets", items: c.takeaways });
  summary.blocks.push({ type: "section", title: "Verdict" });
  summary.blocks.push({ type: "verdict", conviction: c.verdict.conviction, note: c.verdict.note });
  summary.blocks.push({ type: "kvcols", title: "Monitorables", items: c.verdict.monitorables });
  summary.blocks.push({ type: "kvcols", title: "Re-rating triggers", items: c.verdict.triggers });

  // 2 · Concall
  const concall = { name: "Concall", subtitle: sub, blocks: [] };
  concall.blocks.push({ type: "section", title: "Guidance" });
  concall.blocks.push(tbl(
    ["Metric", "Horizon", "Value", "Statement", "Type", "Source"],
    [{}, {}, {}, { wide: true }, {}, { color: "source" }],
    c.guidance.map((g) => [g.metric, g.horizon, g.value || "—", g.statement, g.type, g.source]),
  ));
  concall.blocks.push({ type: "section", title: "Themes" });
  concall.blocks.push(tbl(
    ["Theme", "Stance", "Evidence", "Source"],
    [{}, { color: "stance" }, { wide: true }, { color: "source" }],
    c.themes.map((t) => [t.theme, t.stance, t.evidence, t.source]),
  ));
  if (c.toneShift) { concall.blocks.push({ type: "section", title: "Tone shift vs last quarter" }); concall.blocks.push({ type: "bullets", items: [c.toneShift] }); }
  concall.blocks.push({ type: "section", title: "Expansion flags" });
  concall.blocks.push(tbl(
    ["Metric", "YoY Δ", "QoQ Δ", "Driver"], [{}, { align: "right" }, { align: "right" }, { wide: true }],
    c.expansion.map((f) => [f.metric, f.yoy, f.qoq, f.driver]),
  ));
  concall.blocks.push({ type: "section", title: "Thesis-trigger checklist" });
  concall.blocks.push(tbl(
    ["Trigger", "Flag", "Evidence"], [{}, { color: "flag" }, { wide: true }],
    c.triggers.map((t) => [t.trigger, t.flag, t.evidence]),
  ));

  // 3 · Thesis & Risks
  const thesis = { name: "Thesis & Risks", subtitle: sub, blocks: [] };
  thesis.blocks.push({ type: "section", title: "Thesis (bull case)" });
  thesis.blocks.push(tbl(["Point", "Proven wrong if", "Source"], [{ wide: true }, { wide: true }, { color: "source" }], c.thesis.map((t) => [t.point, t.falsifier, t.source])));
  thesis.blocks.push({ type: "section", title: "Anti-thesis (bear case)" });
  thesis.blocks.push(tbl(["Point", "Proven wrong if", "Source"], [{ wide: true }, { wide: true }, { color: "source" }], c.antiThesis.map((t) => [t.point, t.falsifier, t.source])));
  thesis.blocks.push({ type: "section", title: "Risks" });
  thesis.blocks.push(tbl(["Risk", "Type", "Source"], [{ wide: true }, {}, { color: "source" }], c.risks.map((x) => [x.risk, x.type, x.source])));

  // 4 · Financials
  const financials = { name: "Financials", subtitle: sub, blocks: [] };
  financials.blocks.push({ type: "section", title: "Model (FY26A / FY27E / FY28E)" });
  financials.blocks.push({
    type: "model", headers: ["Metric", "FY26A", "FY27E", "FY28E", "Driver"],
    rows: c.model.rows.map((row) => ({ metric: row.metric, unit: row.unit === "pct" ? "pct" : "cr", fy26a: row.fy26a, fy27e: row.fy27e, fy28e: row.fy28e, driver: row.driver })),
  });
  financials.blocks.push({ type: "section", title: "Assumptions" });
  financials.blocks.push(tbl(
    ["Lever", "FY27E", "FY28E", "Basis"], [{}, { numFmt: "pct", align: "right" }, { numFmt: "pct", align: "right" }, { wide: true }],
    [
      ["Revenue growth", c.model.growth.fy27, c.model.growth.fy28, c.model.growth.basis],
      ["EBITDA margin", c.model.margin.fy27, c.model.margin.fy28, c.model.margin.basis],
    ],
  ));
  if (c.model.note) { financials.blocks.push({ type: "section", title: "Model note" }); financials.blocks.push({ type: "bullets", items: [c.model.note] }); }

  // 5 · Valuation
  const valuation = { name: "Valuation", subtitle: sub, blocks: [] };
  valuation.blocks.push({ type: "section", title: "Multiples" });
  valuation.blocks.push(tbl(
    ["Multiple", "FY27E", "FY28E"], [{}, { numFmt: "mult", align: "right" }, { numFmt: "mult", align: "right" }],
    [
      ["P/E", c.valuation.pe.fy27e, c.valuation.pe.fy28e],
      ["EV/EBITDA", c.valuation.evEbitda.fy27e, c.valuation.evEbitda.fy28e],
      ["P/S", c.valuation.priceSales.fy27e, c.valuation.priceSales.fy28e],
    ],
  ));
  if (c.valuation.sanity) { valuation.blocks.push({ type: "section", title: "Sanity check" }); valuation.blocks.push({ type: "bullets", items: [c.valuation.sanity] }); }

  return { filename: exportFilename(report, "xlsx"), generated: fmtDate(c.generatedAt), sheets: [summary, concall, thesis, financials, valuation] };
}

// ── CSV fallback (pure) ──────────────────────────────────────────────────────
const csvCell = (v) => { const s = S(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvRow = (cells) => cells.map(csvCell).join(",");

/** A flat CSV covering the essentials — used only when ExcelJS fails to load. */
export function buildCsv(report) {
  const c = reportContent(report);
  const L = [];
  L.push(csvRow(["Munshot · Concall Deep Dive — MGA"]));
  L.push(csvRow([c.company, c.ticker, c.quarter, "Generated " + fmtDate(c.generatedAt)]));
  L.push("");
  L.push(csvRow(["Snapshot"]));
  L.push(csvRow(["CMP (Rs)", isNum(c.inputs.cmp) ? c.inputs.cmp : ""]));
  L.push(csvRow(["Market cap (Rs Cr)", isNum(c.inputs.market_cap_cr) ? c.inputs.market_cap_cr : ""]));
  L.push(csvRow(["Net debt (Rs Cr)", isNum(c.inputs.net_debt_cr) ? c.inputs.net_debt_cr : ""]));
  L.push("");
  L.push(csvRow(["Key Takeaways"]));
  c.takeaways.forEach((t) => L.push(csvRow([t])));
  L.push("");
  L.push(csvRow(["Financial Model", "FY26A", "FY27E", "FY28E", "Driver"]));
  c.model.rows.forEach((r) => L.push(csvRow([r.metric, r.fy26a, r.fy27e, r.fy28e, r.driver])));
  L.push("");
  L.push(csvRow(["Valuation", "FY27E", "FY28E"]));
  L.push(csvRow(["P/E", c.valuation.pe.fy27e, c.valuation.pe.fy28e]));
  L.push(csvRow(["EV/EBITDA", c.valuation.evEbitda.fy27e, c.valuation.evEbitda.fy28e]));
  L.push(csvRow(["P/S", c.valuation.priceSales.fy27e, c.valuation.priceSales.fy28e]));
  L.push("");
  L.push(csvRow(["Verdict", c.verdict.conviction]));
  L.push(csvRow([c.verdict.note]));
  L.push("");
  L.push(csvRow([DISCLAIMER, "Generated " + fmtDate(c.generatedAt)]));
  return L.join("\r\n");
}

// ══════════════════════════════════════════════════════════════════════════════
// RENDER LAYER — browser-only; loads the CDN libs and draws the files.
// ══════════════════════════════════════════════════════════════════════════════
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const done = Array.from(document.scripts).find((s) => s.src === src && s.dataset.loaded === "1");
    if (done) return resolve();
    const el = document.createElement("script");
    el.src = src; el.async = true;
    el.addEventListener("load", () => { el.dataset.loaded = "1"; resolve(); });
    el.addEventListener("error", () => { el.remove(); reject(new Error("Could not load " + src)); });
    document.head.appendChild(el);
  });
}
async function ensureJsPdf() {
  if (!(window.jspdf && window.jspdf.jsPDF)) await loadScript(UNPKG.jspdf);
  if (!(window.jspdf && window.jspdf.jsPDF)) throw new Error("jsPDF failed to initialise.");
  if (!window.jspdf.jsPDF.API.autoTable) await loadScript(UNPKG.autotable);
  return window.jspdf.jsPDF;
}
async function ensureExcelJs() {
  if (!window.ExcelJS) await loadScript(UNPKG.exceljs);
  if (!window.ExcelJS) throw new Error("ExcelJS failed to initialise.");
  return window.ExcelJS;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// ── PDF renderer ─────────────────────────────────────────────────────────────
const PDF_TABLE_BASE = {
  theme: "grid",
  styles: { font: "helvetica", fontSize: 8, cellPadding: 3, lineColor: rgb(BRAND.hair), lineWidth: 0.5, textColor: rgb(BRAND.ink), overflow: "linebreak", valign: "top" },
  alternateRowStyles: { fillColor: rgb(BRAND.tintViolet) },
};

/** Draw the whole PDF from buildPdfModel(report). Packs top-to-bottom; footer on every page. */
export function renderPdf(doc, model) {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 36, BOTTOM = H - 42;
  let y = 44;
  const ensure = (need) => { if (y + need > BOTTOM) { doc.addPage(); y = 50; } };

  // ── masthead (page 1) ──
  doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(...rgb(BRAND.ink));
  doc.text(model.masthead.wordmark, M, y); y += 8;
  // thin brand-gradient rule (indigo | violet | magenta thirds)
  const third = (W - M * 2) / 3;
  [BRAND.indigo, BRAND.violet, BRAND.magenta].forEach((hex, k) => { doc.setFillColor(...rgb(hex)); doc.rect(M + third * k, y, third, 2.4, "F"); });
  y += 12;
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...rgb(BRAND.muted));
  const genLine = `${model.masthead.preparedFor}   ·   Generated ${model.masthead.generated}`;
  doc.text(genLine, M, y); y += 16;

  // company line
  doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(...rgb(BRAND.ink));
  doc.text(model.masthead.company, M, y);
  const cw = doc.getTextWidth(model.masthead.company);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...rgb(BRAND.muted));
  doc.text(model.masthead.ticker, M + cw + 8, y); y += 13;
  let meta = `${model.masthead.quarter}   ·   Concall ${model.masthead.concallDate}`;
  if (model.masthead.transcriptNote) meta += `   ·   ${model.masthead.transcriptNote}`;
  doc.setFontSize(8.5); doc.text(meta, M, y); y += 12;

  // snapshot strip — a 4-col table, conviction cell colour-filled
  doc.autoTable({
    startY: y, margin: { left: M, right: M },
    head: [model.snapshot.map((s) => s.label)],
    body: [model.snapshot.map((s) => s.value)],
    theme: "grid",
    styles: { font: "helvetica", fontSize: 9, cellPadding: 4, halign: "center", lineColor: rgb(BRAND.hair), lineWidth: 0.5, textColor: rgb(BRAND.ink) },
    headStyles: { fillColor: rgb(BRAND.indigo), textColor: 255, fontStyle: "bold", halign: "center", fontSize: 7.5 },
    bodyStyles: { fontStyle: "bold" },
    didParseCell: (d) => {
      if (d.section === "body") { const s = model.snapshot[d.column.index]; if (s && s.color) { d.cell.styles.textColor = rgb(s.color); } }
    },
  });
  y = doc.lastAutoTable.finalY + 16;

  const heading = (id, title) => {
    ensure(38);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(...rgb(BRAND.ink));
    doc.text(`${id} · ${title}`, M, y);
    doc.setDrawColor(...rgb(BRAND.violet)); doc.setLineWidth(1.4); doc.line(M, y + 3.5, M + 26, y + 3.5);
    y += 12;
  };
  const paragraph = (text, size = 8.5, color = BRAND.ink) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(size); doc.setTextColor(...rgb(color));
    const lines = doc.splitTextToSize(text, W - M * 2);
    lines.forEach((ln) => { ensure(size + 3); doc.text(ln, M, y); y += size + 2.5; });
  };
  const colStylesFor = (colTypes, widths) => {
    const cs = {};
    (colTypes || []).forEach((t, i) => {
      cs[i] = cs[i] || {};
      if (t === "num") { cs[i].halign = "right"; }
      if (widths && widths[i]) cs[i].cellWidth = widths[i];
    });
    return cs;
  };
  const colourCells = (colTypes) => (d) => {
    if (d.section !== "body") return;
    const t = (colTypes || [])[d.column.index];
    const raw = d.cell.raw;
    if (t === "stance") { d.cell.styles.textColor = rgb(stanceColor(raw)); d.cell.styles.fontStyle = "bold"; }
    else if (t === "flag") { d.cell.styles.textColor = rgb(flagColor(raw)); d.cell.styles.fontStyle = "bold"; }
    else if (t === "tone") { d.cell.styles.textColor = rgb(toneColor(raw)); d.cell.styles.fontStyle = "bold"; }
    else if (t === "source") { d.cell.styles.textColor = rgb(BRAND.muted); }
  };
  const drawTable = (headers, colTypes, widths, rows, headColor, compact) => {
    ensure(46);
    const opts = {
      startY: y, margin: { left: M, right: M },
      head: [headers], body: rows.length ? rows : [headers.map(() => "—")],
      ...PDF_TABLE_BASE,
      headStyles: { fillColor: rgb(headColor || BRAND.indigo), textColor: 255, fontStyle: "bold", fontSize: 7.5, halign: "left" },
      columnStyles: colStylesFor(colTypes, widths),
      didParseCell: colourCells(colTypes),
    };
    // Small, intentionally-narrow tables (valuation, revenue-mix) size to content — this keeps them
    // tight AND avoids autotable's "N units could not fit" warning when every column is fixed-width.
    if (compact) opts.tableWidth = "wrap";
    doc.autoTable(opts);
    y = doc.lastAutoTable.finalY + 12;
  };

  for (const sec of model.sections) {
    if (sec.kind === "bullets") {
      heading(sec.id, sec.title);
      if (!sec.items.length) { paragraph("—", 8.5, BRAND.muted); }
      sec.items.forEach((it) => {
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...rgb(BRAND.ink));
        const lines = doc.splitTextToSize(it, W - M * 2 - 12);
        ensure(lines.length * 11 + 2);
        doc.setFillColor(...rgb(BRAND.magenta)); doc.circle(M + 2.5, y - 2.6, 1.3, "F");
        lines.forEach((ln, li) => { doc.text(ln, M + 10, y); if (li < lines.length - 1) y += 10.5; });
        y += 12;
      });
      y += 4;
    } else if (sec.kind === "about") {
      heading(sec.id, sec.title);
      paragraph(sec.sector, 9, BRAND.ink);
      if (sec.products.length) paragraph("Products: " + sec.products.join("; "), 8.5, BRAND.muted);
      if (sec.segmentNote) paragraph(sec.segmentNote, 8, BRAND.hold);
      y += 2;
      sec.tables.forEach((t) => drawTable(t.headers, t.colTypes, null, t.rows, BRAND.violet, true));
    } else if (sec.kind === "table") {
      heading(sec.id, sec.title);
      drawTable(sec.headers, sec.colTypes, sec.widths, sec.rows, undefined, sec.compact);
      (sec.footNotes || []).forEach((fn) => paragraph(fn, 7.5, BRAND.muted));
    } else if (sec.kind === "paragraph") {
      heading(sec.id, sec.title); paragraph(sec.text, 8.5, BRAND.ink); y += 2;
    } else if (sec.kind === "twocol") {
      heading(sec.id, sec.title);
      [sec.left, sec.right].forEach((col) => {
        ensure(30);
        doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...rgb(col.color));
        doc.text(col.label, M, y); y += 9;
        drawTable(sec.headers, sec.colTypes, sec.widths, col.rows, col.color);
      });
    } else if (sec.kind === "verdict") {
      ensure(70);
      heading(sec.id, sec.title);
      const boxTop = y - 4;
      const boxPage = doc.getNumberOfPages();
      doc.setFillColor(...rgb(sec.color)); doc.roundedRect(M, y - 2, 150, 15, 2, 2, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(255, 255, 255);
      doc.text(sec.conviction, M + 8, y + 8); y += 22;
      paragraph(sec.note, 8.5, BRAND.ink); y += 2;
      const twoLists = (title, items) => {
        if (!items.length) return;
        doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(...rgb(BRAND.muted));
        ensure(14); doc.text(title, M, y); y += 10;
        items.forEach((it) => {
          doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...rgb(BRAND.ink));
          const lines = doc.splitTextToSize(it, W - M * 2 - 12); ensure(lines.length * 10 + 2);
          doc.setFillColor(...rgb(BRAND.indigo)); doc.circle(M + 2.5, y - 2.4, 1.1, "F");
          lines.forEach((ln, li) => { doc.text(ln, M + 10, y); if (li < lines.length - 1) y += 9.5; });
          y += 11;
        });
      };
      twoLists("Monitorables", sec.monitorables);
      twoLists("Re-rating triggers", sec.triggers);
      // subtle box outline — only when the whole verdict stayed on one page (else the rect coords are
      // meaningless across a page break, so we skip it rather than draw a glitch).
      if (doc.getNumberOfPages() === boxPage) {
        doc.setDrawColor(...rgb(sec.color)); doc.setLineWidth(0.6); doc.roundedRect(M - 6, boxTop - 6, W - M * 2 + 12, y - boxTop + 6, 4, 4, "S");
      }
      y += 12;
    }
  }

  // ── closing panel (its own compact end-card) ──
  doc.addPage(); const cx = W / 2; let cy = H / 2 - 40;
  doc.setFillColor(...rgb(BRAND.tintIndigo)); doc.roundedRect(M + 20, cy - 30, W - M * 2 - 40, 150, 8, 8, "F");
  [BRAND.indigo, BRAND.violet, BRAND.magenta].forEach((hex, k) => { doc.setFillColor(...rgb(hex)); doc.rect(M + 20 + ((W - M * 2 - 40) / 3) * k, cy - 30, (W - M * 2 - 40) / 3, 4, "F"); });
  doc.setFont("helvetica", "bold"); doc.setFontSize(22); doc.setTextColor(...rgb(BRAND.ink));
  doc.text("Thank you.", cx, cy + 20, { align: "center" });
  doc.setFontSize(12); doc.setTextColor(...rgb(BRAND.indigo));
  doc.text("Munshot × MGA", cx, cy + 44, { align: "center" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...rgb(BRAND.muted));
  doc.text(`${model.masthead.company}  ·  ${model.masthead.quarter}`, cx, cy + 64, { align: "center" });
  doc.text(`Generated ${model.masthead.generated}`, cx, cy + 78, { align: "center" });
  const disc = doc.splitTextToSize(DISCLAIMER, W - M * 2 - 80);
  doc.text(disc, cx, cy + 96, { align: "center" });

  // ── footer on every page ──
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...rgb(BRAND.hair)); doc.setLineWidth(0.5); doc.line(M, H - 30, W - M, H - 30);
    doc.setFont("helvetica", "normal"); doc.setFontSize(6.8); doc.setTextColor(...rgb(BRAND.muted));
    doc.text("Munshot × MGA · Confidential", M, H - 20);
    doc.text(`${p} / ${pages}`, W / 2, H - 20, { align: "center" });
    doc.text(DISCLAIMER, W - M, H - 20, { align: "right" });
  }
  return doc;
}

/** Build + save the branded PDF. Loads jsPDF on demand; throws (no silent fallback) if it can't. */
export async function exportPdf(report) {
  const jsPDF = await ensureJsPdf();
  const model = buildPdfModel(report);
  const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
  renderPdf(doc, model);
  doc.save(model.filename);
  return { ok: true, format: "pdf", filename: model.filename };
}

// ── Excel renderer ───────────────────────────────────────────────────────────
const thinBorder = { top: { style: "thin", color: { argb: argb(BRAND.hair) } }, left: { style: "thin", color: { argb: argb(BRAND.hair) } }, bottom: { style: "thin", color: { argb: argb(BRAND.hair) } }, right: { style: "thin", color: { argb: argb(BRAND.hair) } } };
const fill = (hex) => ({ type: "pattern", pattern: "solid", fgColor: { argb: argb(hex) } });
const sourceFillHex = (s) => (s === "Transcript" ? BRAND.tintViolet : s === "PPT" ? "#EAF1FF" : s === "Web" ? "#FEF6E7" : "#F1F5F9");
const stanceFillHex = (s) => (s === "Positive" ? "#E7F7EF" : s === "Negative" ? "#FDECEC" : "#F1F5F9");
const flagFillHex = (f) => (f === "Yes" ? "#E7F7EF" : f === "Partial" ? "#FEF6E7" : "#F1F5F9");
const convictionFillHex = (c) => (c === "Buy-watch" ? "#E7F7EF" : c === "Hold-watch" ? "#FEF6E7" : c === "Avoid-watch" ? "#FDECEC" : "#F1F5F9");

/** Build the colour-graded workbook from buildWorkbookModel(report). */
export async function renderWorkbook(ExcelJS, model) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Munshot × MGA"; wb.created = new Date(0);

  for (const sheet of model.sheets) {
    const ws = wb.addWorksheet(sheet.name, { views: [{ state: "frozen", ySplit: 2 }] });
    const NC = 6; // band/section width
    ws.columns = [{ width: 30 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 46 }];
    let row = 1;
    const merge = (r, n) => ws.mergeCells(r, 1, r, n);

    // brand band + sub-band
    merge(1, NC); const b1 = ws.getCell(1, 1);
    b1.value = "Munshot · Concall Deep Dive — MGA";
    b1.font = { bold: true, size: 13, color: { argb: argb(BRAND.white) } }; b1.fill = fill(BRAND.indigo); b1.alignment = { vertical: "middle", indent: 1 };
    ws.getRow(1).height = 26;
    merge(2, NC); const b2 = ws.getCell(2, 1);
    b2.value = sheet.subtitle; b2.font = { size: 9, color: { argb: argb(BRAND.ink) } }; b2.fill = fill(BRAND.tintViolet); b2.alignment = { vertical: "middle", indent: 1 };
    ws.getRow(2).height = 18;
    row = 4;

    for (const block of sheet.blocks) {
      if (block.type === "section") {
        merge(row, NC); const c = ws.getCell(row, 1);
        c.value = block.title.toUpperCase(); c.font = { bold: true, size: 9.5, color: { argb: argb(BRAND.indigo) } };
        c.fill = fill(BRAND.tintIndigo); c.alignment = { vertical: "middle", indent: 1 }; ws.getRow(row).height = 20;
        row += 1;
      } else if (block.type === "kv") {
        block.pairs.forEach((p, idx) => {
          const [label, value, type] = p;
          const lc = ws.getCell(row, 1); lc.value = label; lc.font = { bold: true, color: { argb: argb(BRAND.muted) } }; lc.border = thinBorder;
          merge(row, NC); // value spans the rest — set after merge via first spanned cell
          const vc = ws.getCell(row, 2);
          if (type === "cr" && isNum(value)) { vc.value = value; vc.numFmt = NUMFMT.cr; vc.alignment = { horizontal: "right" }; }
          else { vc.value = value === "" || value == null ? "—" : value; }
          vc.border = thinBorder;
          if (idx % 2) { lc.fill = fill("#FAFAFF"); vc.fill = fill("#FAFAFF"); }
          row += 1;
        });
        row += 1;
      } else if (block.type === "bullets") {
        (block.items.length ? block.items : ["—"]).forEach((it) => {
          merge(row, NC); const c = ws.getCell(row, 1);
          c.value = "• " + S(it); c.alignment = { wrapText: true, vertical: "top" }; c.font = { size: 9.5 }; c.border = thinBorder;
          row += 1;
        });
        row += 1;
      } else if (block.type === "verdict") {
        const lc = ws.getCell(row, 1); lc.value = "Conviction"; lc.font = { bold: true, color: { argb: argb(BRAND.muted) } }; lc.border = thinBorder;
        const vc = ws.getCell(row, 2); vc.value = block.conviction || "—"; vc.font = { bold: true }; vc.fill = fill(convictionFillHex(block.conviction)); vc.border = thinBorder;
        ws.mergeCells(row, 2, row, NC); row += 1;
        merge(row, NC); const nc = ws.getCell(row, 1); nc.value = block.note || "—"; nc.alignment = { wrapText: true, vertical: "top" }; nc.font = { size: 9.5 }; nc.border = thinBorder;
        ws.getRow(row).height = 48; row += 2;
      } else if (block.type === "kvcols") {
        merge(row, NC); const t = ws.getCell(row, 1); t.value = block.title; t.font = { bold: true, italic: true, size: 9, color: { argb: argb(BRAND.muted) } }; row += 1;
        (block.items.length ? block.items : ["—"]).forEach((it) => {
          merge(row, NC); const c = ws.getCell(row, 1); c.value = "• " + S(it); c.alignment = { wrapText: true, vertical: "top" }; c.font = { size: 9.5 }; c.border = thinBorder; row += 1;
        });
        row += 1;
      } else if (block.type === "model") {
        // header
        block.headers.forEach((h, i) => { const c = ws.getCell(row, i + 1); c.value = h; c.font = { bold: true, color: { argb: argb(BRAND.white) } }; c.fill = fill(BRAND.violet); c.alignment = { horizontal: i >= 1 && i <= 3 ? "right" : "left" }; c.border = thinBorder; });
        row += 1;
        block.rows.forEach((r, ri) => {
          const cells = [r.metric, r.fy26a, r.fy27e, r.fy28e, r.driver];
          cells.forEach((v, i) => {
            const c = ws.getCell(row, i + 1);
            if (i >= 1 && i <= 3) { if (isNum(v)) { c.value = v; c.numFmt = r.unit === "pct" ? NUMFMT.pct : NUMFMT.cr; } else c.value = "—"; c.alignment = { horizontal: "right" }; }
            else c.value = v === "" || v == null ? "—" : v;
            if (i === 4) c.alignment = { wrapText: true, vertical: "top" };
            c.border = thinBorder; if (ri % 2) c.fill = fill(BRAND.tintViolet);
          });
          row += 1;
        });
        row += 1;
      } else if (block.type === "table") {
        // header row
        block.headers.forEach((h, i) => {
          const meta = block.cols[i] || {};
          const c = ws.getCell(row, i + 1); c.value = h; c.font = { bold: true, color: { argb: argb(BRAND.white) } }; c.fill = fill(BRAND.indigo);
          c.alignment = { horizontal: meta.align === "right" || meta.numFmt ? "right" : "left" }; c.border = thinBorder;
        });
        row += 1;
        block.rows.forEach((cells, ri) => {
          cells.forEach((v, i) => {
            const meta = block.cols[i] || {};
            const c = ws.getCell(row, i + 1);
            if (meta.numFmt && isNum(v)) { c.value = v; c.numFmt = NUMFMT[meta.numFmt] || meta.numFmt; c.alignment = { horizontal: "right" }; }
            else if (meta.numFmt) { c.value = "—"; c.alignment = { horizontal: "right" }; }
            else { c.value = v === "" || v == null ? "—" : v; if (meta.align === "right") c.alignment = { horizontal: "right" }; }
            if (meta.wide) c.alignment = { wrapText: true, vertical: "top", horizontal: "left" };
            if (meta.color === "source") c.fill = fill(sourceFillHex(v));
            else if (meta.color === "stance") { c.fill = fill(stanceFillHex(v)); c.font = { bold: true }; }
            else if (meta.color === "flag") { c.fill = fill(flagFillHex(v)); c.font = { bold: true }; }
            else if (ri % 2) c.fill = fill("#FAFAFF");
            c.border = thinBorder;
          });
          row += 1;
        });
        row += 1;
      }
    }

    // footer row
    merge(row + 1, NC); const f = ws.getCell(row + 1, 1);
    f.value = `Munshot × MGA · ${DISCLAIMER}   ·   Generated ${model.generated}`;
    f.font = { size: 8, italic: true, color: { argb: argb(BRAND.muted) } }; f.alignment = { vertical: "middle", indent: 1 };
  }
  return wb;
}

/** Build + save the Excel workbook. Falls back to a CSV download if ExcelJS won't load. */
export async function exportExcel(report) {
  const model = buildWorkbookModel(report);
  try {
    const ExcelJS = await ensureExcelJs();
    const wb = await renderWorkbook(ExcelJS, model);
    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), model.filename);
    return { ok: true, format: "xlsx", filename: model.filename };
  } catch (e) {
    const csv = buildCsv(report);
    const name = model.filename.replace(/\.xlsx$/, ".csv");
    downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), name);
    return { ok: true, format: "csv", fallback: true, filename: name, error: e && e.message };
  }
}
