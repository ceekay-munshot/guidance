#!/usr/bin/env node
// verify-extract.mjs — STEP 8 (part 2): the second-model VERIFICATION pass. An INTERNAL quality
// tool — it adds NO visible section to the client report. It re-reads report.json + transcript.txt,
// asks a second model to judge Step 7's transcript-sourced claims (C.1 guidance, C.3 expansion_flags,
// B's transcript-derived facts) against the transcript, conservatively DROPS only clear
// hallucinations from report.json, and logs ALL verdicts to pipeline/out/<slug>/verification.json.
//
//   node pipeline/verify-extract.mjs "Navin Fluorine"   (OPENAI_API_KEY; optional ANTHROPIC_API_KEY)
//
// VERIFY_MODEL is one configurable constant. Setting a second-provider key (ANTHROPIC_API_KEY) makes
// this a TRUE cross-provider check (a different model family); otherwise it defaults to a different
// OpenAI model than extraction. Deterministic (temp 0.1), cost-logged, never fabricates.

import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callStructured, estimateCost } from "./lib/openai.mjs";
import { callAnthropicStructured, estimateAnthropicCost, DEFAULT_VERIFY_MODEL_ANTHROPIC } from "./lib/anthropic.mjs";
import { VERIFY_JSON_SCHEMA } from "./lib/research-schema.mjs";
import { buildClaims, buildVerifyMessages, applyVerification } from "./lib/verify.mjs";
import { findOutDir } from "./lib/out.mjs";
import { log } from "./lib/util.mjs";

const OUT_ROOT = fileURLToPath(new URL("./out/", import.meta.url));
const DEFAULT_VERIFY_MODEL = "gpt-4o"; // OpenAI, deliberately a DIFFERENT model than extraction's gpt-4.1

/** Two model ids name the same model (allowing for dated suffixes like gpt-4.1-2025-04-14). */
const sameModel = (a, b) => !!a && !!b && (String(a).startsWith(String(b)) || String(b).startsWith(String(a)));

/**
 * Pick the verifier, given WHO produced the extraction (report._step7). An audit is only worth
 * running if the auditor is independent of the author, so preference order is:
 *   1. a different PROVIDER than the extractor  (true cross-provider check)
 *   2. the same provider but a genuinely different MODEL
 *   3. nothing independent available → null, and the caller skips the audit
 *
 * Step 3 matters now that lib/llm.mjs can fail extraction over to Anthropic: in that exact outage
 * both the extractor and the verifier would otherwise default to claude-sonnet-5, leaving one model
 * marking its own homework — the correlated errors an audit exists to catch would sail through.
 */
export function chooseVerifier(extractedBy = {}) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const override = process.env.VERIFY_MODEL;
  const by = extractedBy.provider || "openai"; // older reports predate _step7.provider
  const byModel = extractedBy.model || "";

  if (by !== "anthropic" && anthropicKey) return { provider: "anthropic", key: anthropicKey, model: override || DEFAULT_VERIFY_MODEL_ANTHROPIC, independence: "cross-provider" };
  if (by !== "openai" && openaiKey) return { provider: "openai", key: openaiKey, model: override || DEFAULT_VERIFY_MODEL, independence: "cross-provider" };

  const key = by === "anthropic" ? anthropicKey : openaiKey;
  const model = by === "anthropic" ? (override || DEFAULT_VERIFY_MODEL_ANTHROPIC) : (override || DEFAULT_VERIFY_MODEL);
  if (key && !sameModel(model, byModel)) return { provider: by, key, model, independence: "same provider, different model" };
  return null;
}

async function main() {
  const arg = (process.argv[2] || process.env.COMPANY || "").trim();
  log.step("Munshot verify-extract");

  const found = await findOutDir(OUT_ROOT, arg);
  if (!found) { log.err(`no bundle found in pipeline/out/${arg ? ` for "${arg}"` : ""} — run fetch-company first`); process.exitCode = 1; return; }
  const { dir, slug } = found;

  let report;
  try { report = JSON.parse(await readFile(join(dir, "report.json"), "utf8")); }
  catch { log.err(`no report.json in ${dir} — run extract-concall (Step 7) first`); process.exitCode = 1; return; }
  const transcript = await readFile(join(dir, "transcript.txt"), "utf8").catch(() => "");
  const transcriptAvailable = !!report.meta?.transcript_available && transcript.trim().length > 500;
  log.ok(`report: ${report.meta?.company} (${report.meta?.ticker}) · transcript ${transcript.length} chars`);

  // The verifier is chosen AGAINST the extractor recorded in _step7, so it is never the same model.
  const extractedBy = report._step7 || {};
  const V = chooseVerifier(extractedBy);
  if (!V) {
    const why = `no independent verifier available (extraction ran on ${extractedBy.provider || "openai"}/${extractedBy.model || "?"}; only the same model is configured)`;
    log.warn(`${why} — SKIPPING the audit rather than letting a model mark its own homework`);
    log.info("set ANTHROPIC_API_KEY (or VERIFY_MODEL) so the audit runs on a different model family");
    const audit = { slug, company: report.meta?.company || null, quarter: report.meta?.quarter || null, provider: null, model: null, transcript_available: transcriptAvailable, checked: 0, skipped: why, verdicts: [], dropped: [] };
    await writeFile(join(dir, "verification.json"), JSON.stringify(audit, null, 2));
    return;
  }
  log.info(`extraction by ${extractedBy.provider || "openai"}/${extractedBy.model || "?"} → verifying with ${V.provider}/${V.model} (${V.independence})`);

  const claims = buildClaims(report, { transcriptAvailable });
  if (!transcriptAvailable || !claims.length) {
    // Nothing transcript-sourced to audit — write a "skipped" sidecar and exit clean (not a failure).
    const audit = { slug, company: report.meta?.company || null, quarter: report.meta?.quarter || null, provider: V.provider, model: V.model, transcript_available: transcriptAvailable, checked: 0, skipped: transcriptAvailable ? "no transcript-sourced claims" : "no transcript", verdicts: [], dropped: [] };
    await writeFile(join(dir, "verification.json"), JSON.stringify(audit, null, 2));
    log.warn(`verification skipped (${audit.skipped}) — wrote verification.json with 0 verdicts`);
    return;
  }
  log.info(`auditing ${claims.length} transcript-sourced claims (${claims.filter((c) => c.category === "guidance").length} guidance, ${claims.filter((c) => c.category === "expansion_flag").length} flags, ${claims.filter((c) => c.category === "about").length} about)`);

  // ── call the verifier ──
  const messages = buildVerifyMessages(report, transcript, claims);
  let out, usage, model;
  try {
    log.step(`Calling ${V.provider} (structured outputs) to audit claims…`);
    if (V.provider === "anthropic") ({ data: out, usage, model } = await callAnthropicStructured({ apiKey: V.key, model: V.model, messages, schema: VERIFY_JSON_SCHEMA, schemaName: "verify" }));
    else ({ data: out, usage, model } = await callStructured({ apiKey: V.key, model: V.model, messages, schema: VERIFY_JSON_SCHEMA, schemaName: "verify" }));
  } catch (e) {
    // This pass is an INTERNAL quality tool — it adds nothing visible to the client report. When the
    // provider itself is unavailable (out of credit, rate-limited, down), skipping the audit is far
    // better than throwing away a complete, already-validated analysis: we record that it was
    // skipped and let the run finish. A malformed request is still a real bug → fail loudly.
    const providerDown = ["quota", "auth", "rate_limit", "server", "network"].includes(e.kind);
    if (!providerDown) { log.err(`${V.provider} call failed: ${e.message}`); process.exitCode = 1; return; }
    log.warn(`${V.provider} unavailable (${e.kind}: ${e.message.slice(0, 160)}) — SKIPPING the audit rather than failing the run`);
    const audit = { slug, company: report.meta?.company || null, quarter: report.meta?.quarter || null, provider: V.provider, model: V.model, transcript_available: transcriptAvailable, checked: 0, skipped: `verifier unavailable (${e.kind})`, verdicts: [], dropped: [] };
    await writeFile(join(dir, "verification.json"), JSON.stringify(audit, null, 2));
    return;
  }
  const cost = V.provider === "anthropic" ? estimateAnthropicCost(usage, model) : estimateCost(usage, model);
  log.ok(`${out.verdicts?.length || 0} verdicts returned`);
  log.info(`tokens: in ${cost.inTok} / out ${cost.outTok} · est. cost $${cost.usd.toFixed(4)} (priced as ${cost.priced_as})`);

  // ── apply (drop clear hallucinations) + write both files ──
  const { report: pruned, audit } = applyVerification(report, out, { model, provider: V.provider, transcriptAvailable });
  audit.tokens = { in: cost.inTok, out: cost.outTok };
  audit.est_cost_usd = Number(cost.usd.toFixed(4));

  if (audit.dropped.length) {
    pruned._step8_verify = { provider: V.provider, model, dropped: audit.dropped.length, verified_at: report.meta?.generated_at || null };
    await writeFile(join(dir, "report.json"), JSON.stringify(pruned, null, 2));
    log.step(`Pruned ${audit.dropped.length} unsupported claim(s) → rewrote report.json`);
  } else {
    log.info("no claims dropped — report.json left unchanged");
  }
  await writeFile(join(dir, "verification.json"), JSON.stringify(audit, null, 2));
  log.step(`Wrote ${join("pipeline/out", slug, "verification.json")}`);

  // ── summary ──
  log.step("VERIFICATION SUMMARY (internal audit — not in the client report)");
  console.log(`  checked          ${audit.checked}  (supported ${audit.tally.supported} / partial ${audit.tally.partial} / unsupported ${audit.tally.unsupported})`);
  console.log(`  dropped          ${audit.dropped.length}  (guidance + expansion flags only)`);
  audit.dropped.forEach((d) => console.log(`     ✗ ${d.ref} — ${d.note.slice(0, 90)}`));
  console.log(`  flagged (kept)   ${audit.flagged.length}  (Section B / low-confidence — logged, not pruned)`);
  audit.flagged.forEach((f) => console.log(`     · ${f.ref} [${f.verdict}] — ${f.note.slice(0, 80)}`));
  console.log(`  provider/model   ${V.provider} / ${model}`);
}

if (process.argv[1]) {
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
  } catch { /* not the entry module */ }
}
