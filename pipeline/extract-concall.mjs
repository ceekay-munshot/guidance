#!/usr/bin/env node
// extract-concall.mjs — STEP 7: the first LLM step.
// Reads a Step-6 bundle (pipeline/out/<slug>/{bundle.json, transcript.txt, ppt.txt}), calls OpenAI
// with structured outputs to extract report Sections B + C.1–C.5, C.7, C.8, and writes/augments
// pipeline/out/<slug>/report.json. C.6 risks stay []; D/E/F/G are later steps. No schema change.
//
//   node pipeline/extract-concall.mjs "Navin Fluorine"   (needs OPENAI_API_KEY)
//
// Model is one swappable constant (OPENAI_MODEL env, default gpt-4.1). Deterministic (temp 0.1),
// cost-logged. Degrades gracefully; never fabricates.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callStructured, estimateCost, estTokens, DEFAULT_MODEL } from "./lib/openai.mjs";
import { EXTRACTION_JSON_SCHEMA } from "./lib/extract-schema.mjs";
import { buildMessages, assembleReport, validateBC, verifyQuotes } from "./lib/extract-assemble.mjs";
import { log } from "./lib/util.mjs";

const OUT_ROOT = fileURLToPath(new URL("./out/", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../public/data/report.schema.json", import.meta.url));
const OPENAI_MODEL = process.env.OPENAI_MODEL || DEFAULT_MODEL;
const MAX_CHARS = 800000; // generous guard (~200k tokens); real transcripts are ~50k chars

async function findBundleDir(arg) {
  let entries = [];
  try { entries = await readdir(OUT_ROOT, { withFileTypes: true }); } catch { return null; }
  const cands = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const bundle = JSON.parse(await readFile(join(OUT_ROOT, e.name, "bundle.json"), "utf8"));
      cands.push({ dir: join(OUT_ROOT, e.name), slug: e.name, bundle });
    } catch { /* no/invalid bundle.json here */ }
  }
  if (!cands.length) return null;
  if (arg) {
    const q = arg.trim().toLowerCase();
    const hit = cands.find((c) =>
      [c.bundle.query, c.slug, c.bundle.meta?.ticker, c.bundle.meta?.company].some((v) => (v || "").toLowerCase() === q)
    );
    if (hit) return hit;
  }
  cands.sort((a, b) => String(b.bundle.fetched_at || "").localeCompare(String(a.bundle.fetched_at || "")));
  return cands[0];
}

async function main() {
  const arg = (process.argv[2] || process.env.COMPANY || "").trim();
  const apiKey = process.env.OPENAI_API_KEY;
  log.step(`Munshot extract-concall — model ${OPENAI_MODEL}`);
  if (!apiKey) { log.err("OPENAI_API_KEY missing — cannot extract"); process.exitCode = 1; return; }

  const found = await findBundleDir(arg);
  if (!found) { log.err(`no bundle found in pipeline/out/${arg ? ` for "${arg}"` : ""} — run fetch-company first`); process.exitCode = 1; return; }
  const { dir, slug, bundle } = found;
  log.ok(`bundle: ${bundle.meta?.company} (${bundle.meta?.ticker}) → ${dir}`);

  let transcript = await readFile(join(dir, "transcript.txt"), "utf8").catch(() => "");
  const pptText = await readFile(join(dir, "ppt.txt"), "utf8").catch(() => "");
  const hasTranscript = bundle.meta?.transcript_available && transcript.trim().length > 500;
  const pptOnly = !hasTranscript;
  if (pptOnly) log.warn(`PPT-only extraction (transcript_available=${bundle.meta?.transcript_available}, transcript ${transcript.trim().length} chars) — Section C from PPT, reduced confidence`);

  if (transcript.length > MAX_CHARS) {
    log.warn(`transcript ${transcript.length} chars > MAX_CHARS ${MAX_CHARS} — TRUNCATING (rare; consider chunking). Q&A near the end may be lost.`);
    transcript = transcript.slice(0, MAX_CHARS);
  }
  const contentChars = (pptOnly ? pptText : transcript).length + (pptOnly ? 0 : pptText.length);
  log.info(`documents: transcript ${transcript.length} chars, ppt ${pptText.length} chars · ~${estTokens(contentChars)} input tokens (pre-call est.)`);

  // ── call OpenAI (structured outputs) ──
  const messages = buildMessages(bundle, pptOnly ? "" : transcript, pptText, { pptOnly });
  let llm, usage, model;
  try {
    log.step("Calling OpenAI (structured outputs)…");
    ({ data: llm, usage, model } = await callStructured({ apiKey, model: OPENAI_MODEL, messages, schema: EXTRACTION_JSON_SCHEMA, schemaName: "concall_extract" }));
  } catch (e) {
    log.err(`OpenAI call failed: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const cost = estimateCost(usage, model);
  log.ok(`extracted: ${llm.concall?.guidance?.length || 0} guidance · ${llm.concall?.themes?.length || 0} themes · ${llm.concall?.thesis_triggers?.length || 0} triggers · ${llm.concall?.classification?.length || 0} tags`);
  log.info(`tokens: in ${cost.inTok} / out ${cost.outTok} · est. cost $${cost.usd.toFixed(4)} (priced as ${cost.priced_as})`);

  // ── assemble into report.json (augment if it exists) ──
  let existing = null;
  try { existing = JSON.parse(await readFile(join(dir, "report.json"), "utf8")); } catch { /* first write */ }
  const report = assembleReport(existing, bundle, llm, { pptOnly, generated_at: new Date().toISOString() });

  // ── provenance: keep only quotes that are genuinely findable in the source (guarantees Ctrl+F) ──
  const sourceText = pptOnly ? pptText : `${transcript}\n${pptText}`;
  const vq = verifyQuotes(report, sourceText);
  log.info(`verbatim quotes: ${vq.kept} verified · ${vq.dropped} dropped (not found in source → null)`);

  // ── validate B + C against report.schema.json ──
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
  const v = validateBC(report, schema);
  report._step7 = { model, tokens: { in: cost.inTok, out: cost.outTok }, est_cost_usd: Number(cost.usd.toFixed(4)), ppt_only: pptOnly, validated: v.ok, extracted_at: report.meta.generated_at };

  await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
  log.step(`Wrote ${join("pipeline/out", slug, "report.json")}`);

  // ── summary ──
  log.step("EXTRACTION SUMMARY (B + C)");
  console.log(`  sector           ${report.about.sector} / ${report.about.sub_sector}`);
  console.log(`  products         ${report.about.products.length} · segments ${report.about.segments.length} (reported=${report.about.segment_reported})`);
  console.log(`  revenue_mix      ${report.about.revenue_mix.map((r) => `${r.segment} ${r.pct}%`).join(", ") || "—"}`);
  console.log(`  C.1 guidance     ${report.concall.guidance.length} (${report.concall.guidance.filter((g) => g.type === "hard").length} hard / ${report.concall.guidance.filter((g) => g.type === "directional").length} directional)`);
  console.log(`  C.2 themes       ${report.concall.themes.length} · tone_shift="${report.concall.tone_shift_vs_last_quarter}"`);
  console.log(`  C.3 flags        ${report.concall.expansion_flags.length}`);
  console.log(`  C.4 triggers     ${report.concall.thesis_triggers.map((t) => `${t.trigger}:${t.flag}`).join(", ")}`);
  console.log(`  C.5 tags         ${report.concall.classification.map((t) => t.tag).join(", ") || "—"}`);
  console.log(`  C.7 mgmt tone    ${report.concall.management_tone.length}`);
  console.log(`  C.8 analyst      hot=${report.concall.analyst_tone.hot_themes.length} tenor=${report.concall.analyst_tone.qa_tenor}`);
  console.log(`  C.6 risks        ${report.concall.risks.length} (left empty — Step 8)`);
  console.log(`  every C source   = "${pptOnly ? "PPT" : "Transcript"}"`);
  console.log(`\n  B+C schema validation: ${v.ok ? "PASS ✓" : "FAIL ✗"}`);
  v.errors.forEach((e) => console.log(`    ✗ ${e}`));
  v.warnings.forEach((w) => console.log(`    · ${w}`));

  process.exitCode = v.ok ? 0 : 1;
}

if (process.argv[1]) {
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
  } catch { /* not the entry module */ }
}
