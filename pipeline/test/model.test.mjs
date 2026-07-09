// model.test.mjs — offline unit tests for Step 9 (no network, no LLM, no deps).
// Run: node pipeline/test/model.test.mjs
// Verifies the guidance→assumption mapping + basis tags, the row math, the seeded-valuation ==
// frontend-recompute consistency (imports the REAL public/js/report.js computeModel), the n.m.
// edges, the sanity-check trigger logic, monitorables-from-guidance, key_takeaways count, and
// FULL-report schema validation.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildModelMessages, assembleModel, validateEFG,
  buildFinalizeMessages, assembleKeyTakeaways, validateFull, stripInternal,
} from "../lib/model-assemble.mjs";
import { computeValuation, assessValuationRichness, buildSanityCheck, deriveMonitorables } from "../lib/model.mjs";
// The frontend's live recompute — the seeded report MUST reconcile against this on load.
import { computeModel, seedEdits } from "../../public/js/report.js";

const F = (p) => fileURLToPath(new URL(p, import.meta.url));
const report8 = JSON.parse(await readFile(F("../test-fixtures/report.step8.json"), "utf8"));
const bundle = JSON.parse(await readFile(F("../test-fixtures/bundle.step9.json"), "utf8"));
const modelLlm = JSON.parse(await readFile(F("../test-fixtures/model-response.json"), "utf8"));
const takeawaysLlm = JSON.parse(await readFile(F("../test-fixtures/takeaways-response.json"), "utf8"));
const schema = JSON.parse(await readFile(F("../../public/data/report.schema.json"), "utf8"));
const ctx = bundle.valuation_context;

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };
const near = (a, b, eps = 0.05) => typeof a === "number" && Math.abs(a - b) <= eps;

// ── buildModelMessages ──
const mm = buildModelMessages(report8, bundle.fy26a, ctx, {});
ok(mm.length === 2 && /ASSUMPTIONS RULE/.test(mm[0].content), "model system carries the assumptions rule");
ok(/USE THAT NUMBER/i.test(mm[0].content) && /gross_margin.*only if/i.test(mm[0].content), "system: use guided numbers; gross margin only if supported");
ok(mm[1].content.includes("current P/E 59.5") && mm[1].content.includes("peer median P/E 38"), "user carries the Screener valuation context");
ok(mm[1].content.includes("Revenue growth") && mm[1].content.includes("~20%"), "user carries C.1 guidance for the assumption mapping");

// ── assembleModel: mapping + basis tags + row math ──
const { report: modelReport, warnings, richness, valuationInternal } = assembleModel(report8, bundle.fy26a, modelLlm, ctx, { generated_at: "2026-07-09T12:00:00Z", positiveTone: false });
const rowOf = (k) => modelReport.financials.rows.find((r) => r.key === k);
ok(modelReport.financials.assumptions.revenue_growth.fy27 === 20 && modelReport.financials.assumptions.margin.fy27 === 25, "guided numbers used (growth 20, margin 25)");
ok(modelReport.financials.assumptions.revenue_growth.basis.startsWith("mgmt guidance"), "revenue growth tagged 'mgmt guidance' (C.1 has it)");
ok(modelReport.financials.assumptions.margin.basis.startsWith("mgmt guidance"), "EBITDA margin tagged 'mgmt guidance' (C.1 has it)");
ok(rowOf("revenue").fy27e === 3977 && rowOf("revenue").fy28e === 4693, "revenue row: 3314×1.20→3977, ×1.18→4693");
ok(rowOf("ebitda").fy27e === 994 && rowOf("pat").fy27e === 795, "EBITDA 3976.8×25%→994, PAT ×20%→795");
ok(rowOf("gross_margin_pct").fy27e === null, "gross margin left null (not reported) — never invented");
ok(!modelReport.financials.rows.some((r) => r.key === "adj_ebitda_margin_pct"), "adj EBITDA row omitted (company doesn't report it)");
ok(modelReport.financials.rows.length === 6, "6 rows (the mandatory keys, no adj row)");

// ── Est. fallback when a metric was NOT guided ──
const noGuide = JSON.parse(JSON.stringify(report8));
noGuide.concall.guidance = noGuide.concall.guidance.filter((g) => !/revenue/i.test(g.metric)); // drop revenue guidance
const { report: estReport } = assembleModel(noGuide, bundle.fy26a, modelLlm, ctx, {});
ok(estReport.financials.assumptions.revenue_growth.basis.startsWith("Est."), "revenue growth tagged 'Est.' when C.1 has no revenue guidance");

// ── F valuation: seeded == frontend recompute (no mismatch on load) ──
ok(modelReport.valuation.pe.fy27e === 49.7 && modelReport.valuation.pe.fy28e === 40.1, "P/E 49.7 / 40.1 (market_cap/PAT)");
ok(modelReport.valuation.ev_ebitda.fy27e === 41.0 && modelReport.valuation.price_sales.fy27e === 9.9, "EV/EBITDA 41.0 and P/S 9.9 FY27E");
const seed = seedEdits(modelReport);
const cm = computeModel(modelReport, seed);
const round1 = (v) => Math.round(v * 10) / 10;
ok(round1(cm.valuation.pe.fy27e) === modelReport.valuation.pe.fy27e && round1(cm.valuation.pe.fy28e) === modelReport.valuation.pe.fy28e, "frontend recompute reproduces P/E exactly");
ok(round1(cm.valuation.ev_ebitda.fy27e) === modelReport.valuation.ev_ebitda.fy27e && round1(cm.valuation.price_sales.fy27e) === modelReport.valuation.price_sales.fy27e, "frontend recompute reproduces EV/EBITDA + P/S");
ok(Math.round(cm.revenue.fy27e) === rowOf("revenue").fy27e && Math.round(cm.pat.fy27e) === rowOf("pat").fy27e, "frontend recompute reproduces the revenue + PAT rows");

// ── n.m. edges (pat ≤ 0, ebitda ≤ 0 → null, not a fake number) ──
const lossF = { revenue: { fy27e: 100, fy28e: 120 }, ebitda: { fy27e: -5, fy28e: 10 }, pat: { fy27e: -20, fy28e: 5 } };
const lossVal = computeValuation({ cmp: 100, shares_out_cr: 1, net_debt_cr: 0 }, lossF);
ok(lossVal.pe.fy27e === null && lossVal.ev_ebitda.fy27e === null, "n.m.: pat≤0 and ebitda≤0 → null (never faked)");
ok(lossVal.pe.fy28e !== null && lossVal.price_sales.fy27e !== null, "positive denominators still compute");

// ── sanity-check trigger logic ──
ok(richness.is_rich_vs_hist && richness.is_rich_vs_peer, "richness: 49.7x is rich vs 45x median and 38x peer");
const notRich = assessValuationRichness(30, ctx);
ok(!notRich.is_rich, "richness: 30x is NOT rich vs 45x median / 38x peer");
// valuationInternal carries market_cap_cr / ev_cr (used by the sanity-check text)
const richSanity = buildSanityCheck({ valuation: valuationInternal, inputs: report8.meta.inputs, currentPe: 59.5, richness, positiveTone: true });
ok(/RICH/.test(richSanity) && richSanity.includes("49.7x") && richSanity.includes("45x") && richSanity.includes("38x"), "positive tone + rich multiple → flags the disconnect WITH the real numbers");
const calmSanity = buildSanityCheck({ valuation: { pe: { fy27e: 30, fy28e: 26 }, ev_ebitda: { fy27e: 20 }, price_sales: { fy27e: 5 }, market_cap_cr: 39514, ev_cr: 40786 }, inputs: report8.meta.inputs, currentPe: 40, richness: notRich, positiveTone: true });
ok(/in line/.test(calmSanity), "not-rich multiple → 'broadly in line', no false alarm");

// ── monitorables derived from guidance ──
const mon = modelReport.next_steps.monitorables;
ok(report8.concall.guidance.every((g) => mon.some((s) => s.includes(g.metric))), "every C.1 guidance metric becomes a monitorable");
ok(modelReport.next_steps.conviction === "Hold-watch", "conviction carried through");

// ── validate E/F/G slices ──
const ve = validateEFG(modelReport, schema);
ok(ve.ok, "E/F/G validate against report.schema.json" + (ve.ok ? "" : " :: " + ve.errors.slice(0, 3).join(" | ")));

// ── finalize: key_takeaways ──
const fm = buildFinalizeMessages(modelReport);
ok(/5 to 7/.test(fm[0].content) && fm[1].content.includes("FY27E P/E 49.7"), "finalize prompt asks for 5-7 bullets + carries the valuation read");
const { report: finalReport } = assembleKeyTakeaways(modelReport, takeawaysLlm);
ok(finalReport.key_takeaways.length >= 5 && finalReport.key_takeaways.length <= 7, "key_takeaways count is 5-7");
const clamped = assembleKeyTakeaways(modelReport, { key_takeaways: Array.from({ length: 12 }, (_, i) => `t${i}`) });
ok(clamped.report.key_takeaways.length === 7, "key_takeaways clamped to 7 when the model over-produces");

// ── FULL report schema validation (the first COMPLETE report) ──
const withMeta = { ...finalReport, _step9: { model: "gpt-4.1" }, _step7: { x: 1 } }; // simulate step metadata
const clean = stripInternal(withMeta);
ok(!("_step9" in clean) && !("_step7" in clean), "stripInternal drops internal _step* keys before validation");
const vf = validateFull(clean, schema);
ok(vf.ok, "FULL report validates end-to-end against report.schema.json" + (vf.ok ? "" : " :: " + vf.errors.slice(0, 4).join(" | ")));
// negative: a real violation must fail loudly
const broken = JSON.parse(JSON.stringify(clean));
broken.next_steps.conviction = "Strong Buy"; // not in enum
ok(!validateFull(broken, schema).ok, "full validation rejects an out-of-enum conviction");

console.log(fails === 0 ? "\nMODEL + FINALIZE (Step 9) OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
