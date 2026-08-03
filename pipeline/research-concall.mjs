#!/usr/bin/env node
// research-concall.mjs — STEP 8 (part 1): web-grounded C.6 risks + Section D thesis / anti-thesis.
// Reads the report.json Step 7 wrote, runs a handful of TARGETED web queries (OpenAI web_search →
// Firecrawl fallback), asks the model for off-call risks + a falsifiable bull/bear thesis, and
// merges those slices back into report.json. Leaves E/F/G/key_takeaways for Step 9. No schema change.
//
//   node pipeline/research-concall.mjs "Navin Fluorine"   (needs OPENAI_API_KEY; FIRECRAWL_API_KEY optional)
//
// Model is the same swappable OPENAI_MODEL constant as Step 7. Deterministic (temp 0.1), cost-logged,
// degrades gracefully (no web findings → empty risks, Est.-only thesis), never fabricates.

import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateCost, DEFAULT_MODEL } from "./lib/openai.mjs";
import { callLLMStructured, estimateLLMCost, llmApiKey, llmApiKeyEnvName, llmModel, LLM_LABEL } from "./lib/llm.mjs";
import { RISK_THESIS_JSON_SCHEMA } from "./lib/research-schema.mjs";
import { buildRiskThesisMessages, assembleResearch, validateResearch } from "./lib/research-assemble.mjs";
import { gatherWebContext, researchQueries } from "./lib/websearch.mjs";
import { findOutDir } from "./lib/out.mjs";
import { log } from "./lib/util.mjs";

const OUT_ROOT = fileURLToPath(new URL("./out/", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../public/data/report.schema.json", import.meta.url));
// OpenAI web_search (below) has no Bedrock/Claude equivalent in scope — it always uses OPENAI_MODEL
// and OPENAI_API_KEY directly, regardless of LLM_PROVIDER, and degrades gracefully (Firecrawl → none)
// when no OpenAI key is set. Only the structured risk/thesis completion is toggle-aware (LLM_MODEL).
const OPENAI_MODEL = process.env.OPENAI_MODEL || DEFAULT_MODEL;
const LLM_MODEL = llmModel();

async function main() {
  const arg = (process.argv[2] || process.env.COMPANY || "").trim();
  const openaiKeyForSearch = process.env.OPENAI_API_KEY;
  const apiKey = llmApiKey();
  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  log.step(`Munshot research-concall (C.6 + D) — model ${LLM_MODEL}`);
  if (!apiKey) { log.err(`${llmApiKeyEnvName()} missing — cannot research`); process.exitCode = 1; return; }

  const found = await findOutDir(OUT_ROOT, arg);
  if (!found) { log.err(`no bundle found in pipeline/out/${arg ? ` for "${arg}"` : ""} — run fetch-company first`); process.exitCode = 1; return; }
  const { dir, slug } = found;

  let report;
  try { report = JSON.parse(await readFile(join(dir, "report.json"), "utf8")); }
  catch { log.err(`no report.json in ${dir} — run extract-concall (Step 7) first`); process.exitCode = 1; return; }
  log.ok(`report: ${report.meta?.company} (${report.meta?.ticker}) → ${dir}`);

  // ── web research (targeted queries; graceful if no provider) ──
  const queries = researchQueries(report.meta?.company, report.about?.sector);
  log.step(`Web research — ${queries.length} targeted queries${firecrawlKey ? "" : " (no FIRECRAWL_API_KEY; OpenAI web_search only)"}`);
  const web = await gatherWebContext({ queries, openaiKey: openaiKeyForSearch, model: OPENAI_MODEL, firecrawlKey, log });
  log.info(`web provider: ${web.provider} · ${web.citations.length} citations · ${web.context.length} context chars`);
  if (web.provider === "none") log.warn("no web findings — risks will be empty; thesis will be Est.-only");

  // ── structured risk + thesis extraction ──
  const messages = buildRiskThesisMessages(report, web, {});
  let llm, usage, model;
  try {
    log.step(`Calling ${LLM_LABEL} (structured outputs) for risks + thesis…`);
    ({ data: llm, usage, model } = await callLLMStructured({ apiKey, model: LLM_MODEL, messages, schema: RISK_THESIS_JSON_SCHEMA, schemaName: "risk_thesis" }));
  } catch (e) {
    log.err(`${LLM_LABEL} call failed: ${e.message}`); process.exitCode = 1; return;
  }
  const cost = estimateLLMCost(usage, model);
  const webCost = estimateCost({ prompt_tokens: web.usage.input_tokens, completion_tokens: web.usage.output_tokens }, model);
  log.ok(`extracted: ${llm.risks?.length || 0} risks · ${llm.thesis?.length || 0} thesis · ${llm.anti_thesis?.length || 0} anti-thesis`);
  log.info(`tokens: research in ${cost.inTok}/out ${cost.outTok} + web in ${webCost.inTok}/out ${webCost.outTok} · est. cost $${(cost.usd + webCost.usd).toFixed(4)} (priced as ${cost.priced_as})`);

  // ── assemble (source-tag risks=Web, enforce falsifiers) + validate ──
  const { report: merged, warnings, dropped } = assembleResearch(report, llm, { generated_at: new Date().toISOString() });
  dropped.forEach((d) => log.warn(`dropped ${d.section} point (no falsifier): "${(d.point || "").slice(0, 60)}"`));
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
  const v = validateResearch(merged, schema);
  merged._step8_research = {
    model, web_provider: web.provider, citations: web.citations.length,
    tokens: { research_in: cost.inTok, research_out: cost.outTok, web_in: webCost.inTok, web_out: webCost.outTok },
    est_cost_usd: Number((cost.usd + webCost.usd).toFixed(4)), validated: v.ok, researched_at: merged.meta.generated_at,
  };

  await writeFile(join(dir, "report.json"), JSON.stringify(merged, null, 2));
  log.step(`Wrote ${join("pipeline/out", slug, "report.json")}`);

  // ── summary ──
  log.step("RESEARCH SUMMARY (C.6 + D)");
  console.log(`  C.6 risks        ${merged.concall.risks.length}${merged.concall.risks.length ? "" : " (none surfaced — not fabricated)"}`);
  merged.concall.risks.forEach((r) => console.log(`     · [${r.type}] ${r.risk.slice(0, 100)}`));
  console.log(`  D thesis         ${merged.thesis.length} (each with a falsifier)`);
  console.log(`  D anti_thesis    ${merged.anti_thesis.length} (each with a falsifier)`);
  console.log(`\n  C.6+D schema validation: ${v.ok ? "PASS ✓" : "FAIL ✗"}`);
  v.errors.forEach((e) => console.log(`    ✗ ${e}`));
  [...warnings, ...v.warnings].forEach((w) => console.log(`    · ${w}`));

  process.exitCode = v.ok ? 0 : 1;
}

if (process.argv[1]) {
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
  } catch { /* not the entry module */ }
}
