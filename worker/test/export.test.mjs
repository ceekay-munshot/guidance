// export.test.mjs — offline unit tests for the STEP 12 export builders (no DOM, no CDN libs).
// Run: node worker/test/export.test.mjs
//
// The DATA layer (reportContent / buildPdfModel / buildWorkbookModel / buildCsv / exportFilename) is
// pure and DOM-free, so it tests in Node. We assert: (1) a full, correctly-shaped model from the
// real sample report; (2) no throw + sane output on a PPT-only report (empty concall arrays, null
// FY26A, no transcript); (3) no throw on a bare {} report (every field missing). The RENDER layer
// (jsPDF / ExcelJS) only runs in the browser and is exercised by the owner's manual QA.

import { readFile } from "node:fs/promises";
import {
  reportContent, buildPdfModel, buildWorkbookModel, buildCsv, exportFilename, fmtDate,
} from "../../public/js/export.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };
const noThrow = (fn, m) => { try { fn(); ok(true, m); } catch (e) { ok(false, `${m} (threw: ${e.message})`); } };

const sample = JSON.parse(await readFile(new URL("../../public/data/sample-report.json", import.meta.url), "utf8"));

// ── a PPT-only report: no transcript, empty concall arrays, null FY26A, only the 6 required rows ──
const pptOnly = {
  meta: {
    company: "Testco Industries Ltd", ticker: "TESTCO", slug: "testco", quarter: "Q1FY27",
    quarter_confirmed: false, generated_at: "2026-07-10T00:00:00Z", transcript_available: false,
    sources: { transcript_url: null, ppt_url: "https://example.com/ppt.pdf", concall_date: null },
    inputs: { cmp: 100, cmp_date: "2026-07-09", shares_out_cr: 10, market_cap_cr: 1000, net_debt_cr: 0 },
  },
  key_takeaways: ["Only the investor deck was available this quarter — no transcript."],
  about: { sector: "Testing", sub_sector: "QA", products: [], segments: [], segment_reported: false, revenue_mix: [], margin_by_segment: [] },
  concall: { guidance: [], themes: [], tone_shift_vs_last_quarter: "", expansion_flags: [], thesis_triggers: [], classification: [], risks: [], management_tone: [], analyst_tone: { hot_themes: [], qa_tenor: "perfunctory" } },
  thesis: [], anti_thesis: [],
  financials: {
    rows: [
      { key: "revenue", metric: "Revenue", unit: "rs_cr", fy26a: null, fy27e: 120, fy28e: 140, driver: "—" },
      { key: "gross_margin_pct", metric: "Gross margin %", unit: "pct", fy26a: null, fy27e: 40, fy28e: 41, driver: "—" },
      { key: "ebitda", metric: "EBITDA", unit: "rs_cr", fy26a: null, fy27e: 24, fy28e: 30, driver: "—" },
      { key: "ebitda_margin_pct", metric: "EBITDA margin %", unit: "pct", fy26a: null, fy27e: 20, fy28e: 21, driver: "—" },
      { key: "pat", metric: "PAT", unit: "rs_cr", fy26a: null, fy27e: 12, fy28e: 16, driver: "—" },
      { key: "net_margin_pct", metric: "Net margin %", unit: "pct", fy26a: null, fy27e: 10, fy28e: 11, driver: "—" },
    ],
    assumptions: { revenue_growth: { fy27: 20, fy28: 16.7, basis: "" }, margin: { fy27: 20, fy28: 21, basis: "" }, note: "" },
  },
  valuation: { pe: { fy27e: 83.3, fy28e: 62.5 }, ev_ebitda: { fy27e: 41.7, fy28e: 33.3 }, price_sales: { fy27e: 8.3, fy28e: 7.1 }, sanity_check: "" },
  next_steps: { monitorables: [], rerating_triggers: [], conviction: "Avoid-watch", conviction_note: "" },
};

// ══ exportFilename ══
ok(exportFilename(sample, "pdf") === "Munshot-ConcallDeepDive-NAVINFLUOR-Q4FY26.pdf", "filename: ticker + quarter → PDF name");
ok(exportFilename(sample, "xlsx") === "Munshot-ConcallDeepDive-NAVINFLUOR-Q4FY26.xlsx", "filename: xlsx variant");
ok(exportFilename({}, "pdf") === "Munshot-ConcallDeepDive-REPORT-Latest.pdf", "filename: bare report → safe fallback name");
ok(/^Munshot-ConcallDeepDive-TESTCO-Q1FY27\.xlsx$/.test(exportFilename(pptOnly, "xlsx")), "filename: PPT-only report");

// ══ fmtDate ══
ok(fmtDate("2026-07-09T06:30:00Z") === "09 Jul 2026", "fmtDate: ISO → readable date");
ok(fmtDate(null) === "—" && fmtDate("garbage") === "—", "fmtDate: missing/invalid → em-dash");

// ══ reportContent (guarded normalisation) ══
const c = reportContent(sample);
ok(c.company === "Navin Fluorine International Ltd" && c.ticker === "NAVINFLUOR", "content: meta mapped");
ok(c.takeaways.length === 7 && c.model.rows.length === 7, "content: arrays carried through");
ok(c.verdict.conviction === "Hold-watch" && c.verdict.monitorables.length === 5, "content: verdict mapped");
const ce = reportContent({});
ok(ce.company === "—" && Array.isArray(ce.takeaways) && ce.takeaways.length === 0, "content: bare {} → guarded empties, no throw");
ok(ce.model.rows.length === 0 && ce.valuation.pe.fy27e === undefined, "content: bare {} → empty model/valuation");

// ══ buildPdfModel ══
noThrow(() => buildPdfModel(sample), "pdfModel: builds from the real sample");
noThrow(() => buildPdfModel(pptOnly), "pdfModel: builds from a PPT-only report");
noThrow(() => buildPdfModel({}), "pdfModel: builds from a bare {} report");
const pm = buildPdfModel(sample);
ok(pm.filename === "Munshot-ConcallDeepDive-NAVINFLUOR-Q4FY26.pdf", "pdfModel: filename set");
ok(pm.masthead.wordmark === "Munshot Concall Deep Dive", "pdfModel: masthead wordmark");
ok(pm.snapshot.length === 4 && pm.snapshot[0].label === "CMP" && /^Rs /.test(pm.snapshot[0].value), "pdfModel: snapshot chips (Rs-prefixed, no ₹ tofu)");
ok(pm.snapshot[3].label === "Conviction" && pm.snapshot[3].color === "#F59E0B", "pdfModel: conviction chip colour-coded (Hold=amber)");
const secIds = pm.sections.map((s) => s.id);
["A", "B", "C.1", "D", "E", "F", "G"].forEach((id) => ok(secIds.includes(id), `pdfModel: section ${id} present`));
const eSec = pm.sections.find((s) => s.id === "E");
ok(eSec.rows[0][1] === "2,500" && eSec.rows[1][1] === "48.0%", "pdfModel: model cells formatted by unit (cr grouped, pct suffixed)");
const gSec = pm.sections.find((s) => s.id === "G");
ok(gSec.kind === "verdict" && gSec.conviction === "Hold-watch" && gSec.monitorables.length === 5, "pdfModel: verdict section");
// PPT-only: sections with empty arrays are simply omitted; masthead flags no transcript
const pmp = buildPdfModel(pptOnly);
ok(pmp.masthead.transcriptNote === "PPT-only — no transcript", "pdfModel: PPT-only note surfaced");
ok(!pmp.sections.some((s) => s.id === "C.1"), "pdfModel: empty guidance omitted (no blank table)");
ok(pmp.sections.find((s) => s.id === "E").rows[0][1] === "—", "pdfModel: null FY26A → em-dash cell");
// ₹ never leaks into PDF strings (would render as tofu in jsPDF core fonts)
const allPdfText = JSON.stringify(buildPdfModel(sample));
ok(!allPdfText.includes("₹"), "pdfModel: no ₹ glyphs anywhere (sanitised to 'Rs')");

// ══ buildWorkbookModel ══
noThrow(() => buildWorkbookModel(sample), "workbookModel: builds from the real sample");
noThrow(() => buildWorkbookModel(pptOnly), "workbookModel: builds from a PPT-only report");
noThrow(() => buildWorkbookModel({}), "workbookModel: builds from a bare {} report");
const wm = buildWorkbookModel(sample);
ok(wm.filename.endsWith(".xlsx"), "workbookModel: xlsx filename");
ok(wm.sheets.map((s) => s.name).join(",") === "Summary,Concall,Thesis & Risks,Financials,Valuation,Sources", "workbookModel: six sheets in order (incl. Sources)");
const summary = wm.sheets[0];
ok(summary.blocks.some((b) => b.type === "verdict" && b.conviction === "Hold-watch"), "workbookModel: Summary carries the verdict");
ok(summary.blocks.some((b) => b.type === "bullets" && b.items.length === 7), "workbookModel: Summary carries takeaways");
const fin = wm.sheets.find((s) => s.name === "Financials");
const modelBlock = fin.blocks.find((b) => b.type === "model");
ok(modelBlock && modelBlock.rows.length === 7, "workbookModel: Financials model has all rows");
ok(modelBlock.rows[0].unit === "cr" && modelBlock.rows[1].unit === "pct" && modelBlock.rows[0].fy26a === 2500, "workbookModel: model rows keep RAW numbers + unit (Excel number-formats, ×100 bug avoided)");
const val = wm.sheets.find((s) => s.name === "Valuation");
const valTable = val.blocks.find((b) => b.type === "table");
ok(valTable.cols[1].numFmt === "mult" && valTable.rows[0][1] === 44.8, "workbookModel: valuation multiples raw + 'mult' numFmt");
// percentages stored as whole numbers so Excel's 0.0\"%\" shows them correctly (NOT ×100)
const concall = wm.sheets.find((s) => s.name === "Concall");
ok(concall.blocks.some((b) => b.type === "table" && b.cols.some((col) => col.color === "stance")), "workbookModel: themes table flags stance colouring");

// ══ provenance: Sources sheet + link cells ══
const src = wm.sheets.find((s) => s.name === "Sources");
ok(src && src.ncols === 5, "workbookModel: Sources sheet present (5 cols)");
const citedTbl = src.blocks.find((b) => b.type === "table" && b.headers.includes("Verbatim quote"));
ok(citedTbl && citedTbl.cols.some((col) => col.link), "workbookModel: cited-facts table has a link (URL) column");
ok(citedTbl.rows.some((r) => /^https?:\/\//.test(r[4])), "workbookModel: at least one cited fact carries a real URL");
ok(citedTbl.rows.some((r) => r[0] === "Risk" && /icra|bseindia|business-standard/.test(r[4])), "workbookModel: risks carry their web source URL");
ok(src.blocks.some((b) => b.type === "kv" && b.pairs.some((p) => p[2] === "link")), "workbookModel: Documents block links the transcript/deck");
// pdf model carries a Sources section with clickable docs + web
const pmH = buildPdfModel(sample).sections.find((s) => s.id === "H");
ok(pmH && pmH.kind === "sources" && pmH.docs.length === 2, "pdfModel: Sources section with transcript + deck");
ok(pmH.web.length >= 3 && pmH.web.every((w) => w.url), "pdfModel: Sources section lists web sources with URLs");
// reportContent resolves per-fact source URLs (transcript facts → doc URL; web facts → own url)
const rc = reportContent(sample);
ok(rc.guidance[0].url && rc.guidance[0].url.endsWith(".pdf"), "content: transcript guidance resolves to the transcript PDF url");
ok(rc.risks.some((x) => /^https?:\/\//.test(x.url)) && rc.guidance[0].quote, "content: risks carry web url + guidance carries verbatim quote");

// ══ buildCsv (fallback) ══
noThrow(() => buildCsv(sample), "csv: builds from the real sample");
noThrow(() => buildCsv({}), "csv: builds from a bare {} report");
const csv = buildCsv(sample);
ok(csv.includes("Munshot · Concall Deep Dive — MGA"), "csv: branded header line");
ok(csv.includes("NAVINFLUOR") && csv.includes("Q4FY26"), "csv: identity present");
ok(csv.includes("P/E,44.8,34.4"), "csv: valuation row present");
ok(/Research observation, not investment advice/.test(csv), "csv: disclaimer present");
// a field with a comma must be quoted
ok(/"[^"]*,[^"]*"/.test(csv) || !csv.split("\n").some((l) => l.split(",").length > 6), "csv: comma-bearing fields are quoted");

console.log(fails === 0 ? "\nEXPORT BUILDERS (Step 12) OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
