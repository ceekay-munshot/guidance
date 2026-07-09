#!/usr/bin/env node
// model-report.mjs — STEP 9 (part 1): Sections E (financial model), F (valuation), G (next steps).
// Reads the report.json Steps 6–8 wrote + the bundle (FY26A actuals + Screener valuation context),
// asks the model for the ASSUMPTION LEVERS + prose, then computes every rupee figure and every
// multiple DETERMINISTICALLY (mirroring the frontend). Leaves key_takeaways for finalize. No schema
// change. Deterministic (temp 0.1), cost-logged, never fabricates (Est. where no data).
//
//   node pipeline/model-report.mjs "Navin Fluorine"   (needs OPENAI_API_KEY)

import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callStructured, estimateCost, DEFAULT_MODEL } from "./lib/openai.mjs";
import { MODEL_JSON_SCHEMA } from "./lib/model-schema.mjs";
import { buildModelMessages, assembleModel, validateEFG } from "./lib/model-assemble.mjs";
import { findOutDir } from "./lib/out.mjs";
import { log } from "./lib/util.mjs";

const OUT_ROOT = fileURLToPath(new URL("./out/", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../public/data/report.schema.json", import.meta.url));
const OPENAI_MODEL = process.env.OPENAI_MODEL || DEFAULT_MODEL;

/** Positive read? Buy-watch, or a constructive theme balance without an Avoid verdict. */
function isPositiveTone(report, conviction) {
  const th = report.concall?.themes || [];
  const pos = th.filter((t) => t.stance === "Positive").length;
  const neg = th.filter((t) => t.stance === "Negative").length;
  return conviction === "Buy-watch" || (conviction !== "Avoid-watch" && pos >= neg);
}

async function main() {
  const arg = (process.argv[2] || process.env.COMPANY || "").trim();
  const apiKey = process.env.OPENAI_API_KEY;
  log.step(`Munshot model-report (E + F + G) — model ${OPENAI_MODEL}`);
  if (!apiKey) { log.err("OPENAI_API_KEY missing — cannot model"); process.exitCode = 1; return; }

  const found = await findOutDir(OUT_ROOT, arg);
  if (!found) { log.err(`no bundle found in pipeline/out/${arg ? ` for "${arg}"` : ""} — run fetch-company first`); process.exitCode = 1; return; }
  const { dir, slug, bundle } = found;

  let report;
  try { report = JSON.parse(await readFile(join(dir, "report.json"), "utf8")); }
  catch { log.err(`no report.json in ${dir} — run extract-concall (Step 7) first`); process.exitCode = 1; return; }
  const fy26a = bundle.fy26a || {};
  const ctx = bundle.valuation_context || null;
  log.ok(`report: ${report.meta?.company} (${report.meta?.ticker}) · FY26A revenue ₹${fy26a.revenue ?? "—"}cr`);
  log.info(ctx ? `valuation context: current P/E ${ctx.current_pe ?? "n/a"}, 5-yr median ${ctx.hist_median_pe ?? "n/a"}, peer median ${ctx.peer_median_pe ?? "n/a"}` : "valuation context: unavailable (older bundle) — sanity-check judged on absolute multiple");

  // ── model call (assumptions + prose only) ──
  const messages = buildModelMessages(report, fy26a, ctx, {});
  let llm, usage, model;
  try {
    log.step("Calling OpenAI (structured outputs) for the model…");
    ({ data: llm, usage, model } = await callStructured({ apiKey, model: OPENAI_MODEL, messages, schema: MODEL_JSON_SCHEMA, schemaName: "financial_model" }));
  } catch (e) {
    log.err(`OpenAI call failed: ${e.message}`); process.exitCode = 1; return;
  }
  const cost = estimateCost(usage, model);
  log.ok(`assumptions: growth ${llm.revenue_growth_fy27}/${llm.revenue_growth_fy28}% · EBITDA margin ${llm.ebitda_margin_fy27}/${llm.ebitda_margin_fy28}% · conviction ${llm.conviction}`);
  log.info(`tokens: in ${cost.inTok} / out ${cost.outTok} · est. cost $${cost.usd.toFixed(4)} (priced as ${cost.priced_as})`);

  // ── deterministic assembly (rows + multiples) + validation ──
  const positiveTone = isPositiveTone(report, llm.conviction);
  const { report: merged, warnings, richness } = assembleModel(report, fy26a, llm, ctx, { generated_at: new Date().toISOString(), positiveTone });
  warnings.forEach((w) => log.warn(w));
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
  const v = validateEFG(merged, schema);
  merged._step9_model = { model, tokens: { in: cost.inTok, out: cost.outTok }, est_cost_usd: Number(cost.usd.toFixed(4)), rich_vs_hist: richness.is_rich_vs_hist, rich_vs_peer: richness.is_rich_vs_peer, validated: v.ok, modeled_at: merged.meta.generated_at };

  await writeFile(join(dir, "report.json"), JSON.stringify(merged, null, 2));
  log.step(`Wrote ${join("pipeline/out", slug, "report.json")}`);

  // ── summary ──
  const g = (k) => merged.financials.rows.find((r) => r.key === k) || {};
  log.step("MODEL SUMMARY (E + F + G)");
  console.log(`  E revenue        FY26A ₹${g("revenue").fy26a} → FY27E ₹${g("revenue").fy27e} → FY28E ₹${g("revenue").fy28e}cr`);
  console.log(`  E EBITDA         FY27E ₹${g("ebitda").fy27e}cr (${g("ebitda_margin_pct").fy27e}%) · PAT ₹${g("pat").fy27e}cr (${g("net_margin_pct").fy27e}%)`);
  console.log(`  E assumptions    growth ${merged.financials.assumptions.revenue_growth.basis.split(" — ")[0]} · margin ${merged.financials.assumptions.margin.basis.split(" — ")[0]}`);
  console.log(`  F P/E            FY27E ${merged.valuation.pe.fy27e}x · FY28E ${merged.valuation.pe.fy28e}x`);
  console.log(`  F EV/EBITDA      FY27E ${merged.valuation.ev_ebitda.fy27e}x · P/S FY27E ${merged.valuation.price_sales.fy27e}x`);
  console.log(`  F rich?          vs history ${richness.is_rich_vs_hist ? "YES" : "no"} · vs peers ${richness.is_rich_vs_peer ? "YES" : "no"}`);
  console.log(`  G conviction     ${merged.next_steps.conviction} · ${merged.next_steps.monitorables.length} monitorables · ${merged.next_steps.rerating_triggers.length} re-rating triggers`);
  console.log(`\n  E+F+G schema validation: ${v.ok ? "PASS ✓" : "FAIL ✗"}`);
  v.errors.forEach((e) => console.log(`    ✗ ${e}`));

  process.exitCode = v.ok ? 0 : 1;
}

if (process.argv[1]) {
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
  } catch { /* not the entry module */ }
}
