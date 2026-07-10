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
import { salvageReport } from "./lib/salvage.mjs";
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

  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));

  // ── salvage the B–G body FIRST, so key_takeaways are synthesised from the payload we'll actually
  // publish — a dropped/blanked best-effort field must not leave a top bullet citing content that's
  // absent from the body. stripInternal first (drop _step* metadata) so salvage's stray-key sweep
  // doesn't mistake pipeline metadata for unexpected data. key_takeaways is still empty here; the LLM
  // fills it next from `body`. ──
  const bodySalvage = salvageReport(stripInternal(report), schema);
  const body = bodySalvage.report;
  let degraded = bodySalvage.degraded.slice();

  // ── key_takeaways synthesis (across the SALVAGED B–G) ──
  const messages = buildFinalizeMessages(body);
  let llm, usage, model;
  try {
    log.step("Calling OpenAI (structured outputs) for key_takeaways…");
    ({ data: llm, usage, model } = await callStructured({ apiKey, model: OPENAI_MODEL, messages, schema: TAKEAWAYS_JSON_SCHEMA, schemaName: "key_takeaways" }));
  } catch (e) {
    log.err(`OpenAI call failed: ${e.message}`); process.exitCode = 1; return;
  }
  const cost = estimateCost(usage, model);
  const { report: withTakeaways, warnings } = assembleKeyTakeaways(body, llm);
  warnings.forEach((w) => log.warn(w));
  log.ok(`${withTakeaways.key_takeaways.length} key takeaways`);
  log.info(`tokens: in ${cost.inTok} / out ${cost.outTok} · est. cost $${cost.usd.toFixed(4)} (priced as ${cost.priced_as})`);

  // ── validate the COMPLETE report end-to-end ──
  withTakeaways._step9_finalize = { model, tokens: { in: cost.inTok, out: cost.outTok }, est_cost_usd: Number(cost.usd.toFixed(4)), finalized_at: new Date().toISOString() };
  const clean = stripInternal(withTakeaways); // the emitted report.json must be schema-clean
  const v = validateFull(clean, schema);

  // The body is already salvaged (so takeaways match it); this pass only catches any residual, and
  // hard-fails ONLY when something load-bearing (identity, price inputs, model, verdict, takeaways)
  // is broken → never publish a schema-invalid report.
  let publish = null, partial = false, fatal = [];
  if (v.ok) { publish = clean; partial = degraded.length > 0; }
  else {
    const sal = salvageReport(clean, schema);
    if (sal.ok) { publish = sal.report; partial = true; degraded = [...new Set([...degraded, ...sal.degraded])]; }
    else { fatal = sal.fatal.length ? sal.fatal : sal.errors; } // load-bearing if any, else the residual
  }
  const publishable = publish !== null;

  if (publishable) {
    await writeFile(join(dir, "report.json"), JSON.stringify(publish, null, 2));
    log.step(`Wrote ${join("pipeline/out", slug, "report.json")} (complete, internal metadata stripped)`);
    // Sidecar marker → kv-put surfaces "partial" in the done status so the client can note it.
    if (partial) await writeFile(join(dir, "partial.json"), JSON.stringify({ partial: true, degraded }, null, 2));
  }

  // ── summary ──
  log.step("FINAL REPORT SUMMARY (complete B–G)");
  (publish?.key_takeaways || []).forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  if (!publishable) {
    console.log(`\n  FULL report end-to-end schema validation: FAIL ✗ (load-bearing sections broken — not salvageable)`);
    fatal.forEach((e) => console.log(`    ✗ ${e}`));
    log.err(`report.json is INVALID in a load-bearing section — ${fatal.length} violation(s). Failing loudly (see above).`);
  } else if (partial) {
    console.log(`\n  FULL report end-to-end schema validation: PARTIAL ✓ (published with best-effort gaps)`);
    degraded.forEach((d) => log.warn(`degraded (unavailable, left blank): ${d}`));
    log.ok(`Published a PARTIAL report — ${degraded.length} best-effort field(s) unavailable; load-bearing sections intact.`);
  } else {
    console.log(`\n  FULL report end-to-end schema validation: PASS ✓`);
    log.ok("This is a COMPLETE, schema-valid report.");
  }

  process.exitCode = publishable ? 0 : 1;
}

if (process.argv[1]) {
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
  } catch { /* not the entry module */ }
}
