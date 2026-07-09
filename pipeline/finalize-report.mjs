#!/usr/bin/env node
// finalize-report.mjs — STEP 9 (part 2): the final key_takeaways synthesis + END-TO-END validation.
// Reads the now-complete report.json (B–G), asks the model for 5–7 decision-relevant bullets across
// the whole report, strips internal pipeline metadata, and validates the COMPLETE report against
// report.schema.json — FAILING LOUDLY on any violation. This is the first time the pipeline emits a
// full, schema-valid report. No schema change. Deterministic (temp 0.1), cost-logged.
//
//   node pipeline/finalize-report.mjs "Navin Fluorine"   (needs OPENAI_API_KEY)

import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callStructured, estimateCost, DEFAULT_MODEL } from "./lib/openai.mjs";
import { TAKEAWAYS_JSON_SCHEMA } from "./lib/model-schema.mjs";
import { buildFinalizeMessages, assembleKeyTakeaways, validateFull, stripInternal } from "./lib/model-assemble.mjs";
import { findOutDir } from "./lib/out.mjs";
import { log } from "./lib/util.mjs";

const OUT_ROOT = fileURLToPath(new URL("./out/", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../public/data/report.schema.json", import.meta.url));
const OPENAI_MODEL = process.env.OPENAI_MODEL || DEFAULT_MODEL;

async function main() {
  const arg = (process.argv[2] || process.env.COMPANY || "").trim();
  const apiKey = process.env.OPENAI_API_KEY;
  log.step(`Munshot finalize-report (key_takeaways + end-to-end validation) — model ${OPENAI_MODEL}`);
  if (!apiKey) { log.err("OPENAI_API_KEY missing — cannot finalize"); process.exitCode = 1; return; }

  const found = await findOutDir(OUT_ROOT, arg);
  if (!found) { log.err(`no bundle found in pipeline/out/${arg ? ` for "${arg}"` : ""} — run fetch-company first`); process.exitCode = 1; return; }
  const { dir, slug } = found;

  let report;
  try { report = JSON.parse(await readFile(join(dir, "report.json"), "utf8")); }
  catch { log.err(`no report.json in ${dir} — run the earlier steps first`); process.exitCode = 1; return; }
  if (!report.financials || !report.valuation || !report.next_steps) {
    log.err("report.json has no E/F/G yet — run model-report (Step 9 part 1) first"); process.exitCode = 1; return;
  }
  log.ok(`report: ${report.meta?.company} (${report.meta?.ticker})`);

  // ── key_takeaways synthesis (across B–G) ──
  const messages = buildFinalizeMessages(report);
  let llm, usage, model;
  try {
    log.step("Calling OpenAI (structured outputs) for key_takeaways…");
    ({ data: llm, usage, model } = await callStructured({ apiKey, model: OPENAI_MODEL, messages, schema: TAKEAWAYS_JSON_SCHEMA, schemaName: "key_takeaways" }));
  } catch (e) {
    log.err(`OpenAI call failed: ${e.message}`); process.exitCode = 1; return;
  }
  const cost = estimateCost(usage, model);
  const { report: withTakeaways, warnings } = assembleKeyTakeaways(report, llm);
  warnings.forEach((w) => log.warn(w));
  log.ok(`${withTakeaways.key_takeaways.length} key takeaways`);
  log.info(`tokens: in ${cost.inTok} / out ${cost.outTok} · est. cost $${cost.usd.toFixed(4)} (priced as ${cost.priced_as})`);

  // ── strip internal metadata, then validate the COMPLETE report end-to-end ──
  withTakeaways._step9_finalize = { model, tokens: { in: cost.inTok, out: cost.outTok }, est_cost_usd: Number(cost.usd.toFixed(4)), finalized_at: new Date().toISOString() };
  const clean = stripInternal(withTakeaways); // the emitted report.json must be schema-clean
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
  const v = validateFull(clean, schema);

  await writeFile(join(dir, "report.json"), JSON.stringify(clean, null, 2));
  log.step(`Wrote ${join("pipeline/out", slug, "report.json")} (complete, internal metadata stripped)`);

  // ── summary ──
  log.step("FINAL REPORT SUMMARY (complete B–G)");
  withTakeaways.key_takeaways.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  console.log(`\n  FULL report end-to-end schema validation: ${v.ok ? "PASS ✓" : "FAIL ✗"}`);
  v.errors.forEach((e) => console.log(`    ✗ ${e}`));
  if (v.ok) log.ok("This is the first COMPLETE, schema-valid report the pipeline has emitted.");
  else log.err(`report.json is INVALID — ${v.errors.length} violation(s). Failing loudly (see above).`);

  process.exitCode = v.ok ? 0 : 1;
}

if (process.argv[1]) {
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
  } catch { /* not the entry module */ }
}
