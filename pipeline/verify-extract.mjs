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
 * Every verifier that is independent of the extractor, best first:
 *   1. a different PROVIDER than the extractor  (true cross-provider check)
 *   2. the same provider but a genuinely different MODEL
 * The caller tries them in order, so a preferred-but-unreachable verifier (expired Anthropic key,
 * exhausted quota, outage) falls through to the next INDEPENDENT option instead of silently
 * removing verification altogether. An empty list means nothing independent exists — then, and only
 * then, the audit is skipped.
 *
 * Independence matters more now that lib/llm.mjs can fail extraction over to Anthropic: without
 * this, extractor and verifier would both default to claude-sonnet-5 in exactly that outage, leaving
 * one model marking its own homework.
 */
export function verifierCandidates(extractedBy = {}) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const by = extractedBy.provider || "openai"; // older reports predate _step7.provider
  const byModel = extractedBy.model || "";

  // VERIFY_MODEL is a SINGLE setting but there are now two possible verifier providers, so it must
  // only apply to the one it actually names — inferred from the id. Handing an Anthropic model id to
  // OpenAI (or vice versa) earns a 400, which would take down a run whose report was already
  // complete. A setting that was correct under the old Anthropic-first behaviour must not become a
  // landmine the first time extraction fails over.
  const override = process.env.VERIFY_MODEL;
  const isAnthropicModel = (m) => /^claude/i.test(String(m || ""));
  const modelFor = (provider) => {
    const belongs = override && (provider === "anthropic" ? isAnthropicModel(override) : !isAnthropicModel(override));
    if (belongs) return override;
    return provider === "anthropic" ? DEFAULT_VERIFY_MODEL_ANTHROPIC : DEFAULT_VERIFY_MODEL;
  };

  const out = [];
  if (by !== "anthropic" && anthropicKey) out.push({ provider: "anthropic", key: anthropicKey, model: modelFor("anthropic"), independence: "cross-provider" });
  if (by !== "openai" && openaiKey) out.push({ provider: "openai", key: openaiKey, model: modelFor("openai"), independence: "cross-provider" });

  const sameKey = by === "anthropic" ? anthropicKey : openaiKey;
  const sameDefault = modelFor(by);
  if (sameKey && !sameModel(sameDefault, byModel)) out.push({ provider: by, key: sameKey, model: sameDefault, independence: "same provider, different model" });
  return out;
}

/** Backwards-compatible single-best pick (null when nothing independent is available). */
export function chooseVerifier(extractedBy = {}) {
  return verifierCandidates(extractedBy)[0] || null;
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

  // Verifiers are chosen AGAINST the extractor recorded in _step7, so none of them is the same model.
  const extractedBy = report._step7 || {};
  const by = `${extractedBy.provider || "openai"}/${extractedBy.model || "?"}`;
  const candidates = verifierCandidates(extractedBy);
  const writeSkipped = async (why, V) => {
    const audit = { slug, company: report.meta?.company || null, quarter: report.meta?.quarter || null, provider: V?.provider || null, model: V?.model || null, transcript_available: transcriptAvailable, checked: 0, skipped: why, verdicts: [], dropped: [] };
    await writeFile(join(dir, "verification.json"), JSON.stringify(audit, null, 2));
  };
  if (!candidates.length) {
    const why = `no independent verifier available (extraction ran on ${by}; only the same model is configured)`;
    log.warn(`${why} — SKIPPING the audit rather than letting a model mark its own homework`);
    log.info("set ANTHROPIC_API_KEY (or VERIFY_MODEL) so the audit runs on a different model family");
    await writeSkipped(why, null);
    return;
  }
  log.info(`extraction by ${by} → verifier candidates: ${candidates.map((c) => `${c.provider}/${c.model}`).join(", ")}`);

  const claims = buildClaims(report, { transcriptAvailable });
  if (!transcriptAvailable || !claims.length) {
    // Nothing transcript-sourced to audit — write a "skipped" sidecar and exit clean (not a failure).
    // No verifier has been called yet, so record the one we WOULD have used.
    const why = transcriptAvailable ? "no transcript-sourced claims" : "no transcript";
    await writeSkipped(why, candidates[0]);
    log.warn(`verification skipped (${why}) — wrote verification.json with 0 verdicts`);
    return;
  }
  log.info(`auditing ${claims.length} transcript-sourced claims (${claims.filter((c) => c.category === "guidance").length} guidance, ${claims.filter((c) => c.category === "expansion_flag").length} flags, ${claims.filter((c) => c.category === "about").length} about)`);

  // ── call the verifier, trying each INDEPENDENT candidate in turn ──
  const messages = buildVerifyMessages(report, transcript, claims);
  let out, usage, model, V = null, lastErr = null;
  for (const cand of candidates) {
    try {
      log.step(`Calling ${cand.provider}/${cand.model} (${cand.independence}) to audit claims…`);
      if (cand.provider === "anthropic") ({ data: out, usage, model } = await callAnthropicStructured({ apiKey: cand.key, model: cand.model, messages, schema: VERIFY_JSON_SCHEMA, schemaName: "verify" }));
      else ({ data: out, usage, model } = await callStructured({ apiKey: cand.key, model: cand.model, messages, schema: VERIFY_JSON_SCHEMA, schemaName: "verify" }));
      V = cand;
      break;
    } catch (e) {
      lastErr = e;
      // Try the NEXT candidate on any failure, including bad_request. Each candidate sends a
      // different model id, so a 400 is far more likely a wrong-model setting than a broken schema —
      // and the next candidate may well be fine. A genuinely malformed request simply fails on all of
      // them and lands in the skip below, logged loudly, rather than taking the run with it.
      const bug = !["quota", "auth", "rate_limit", "server", "network"].includes(e.kind);
      if (bug) log.err(`${cand.provider}/${cand.model} rejected the request (${e.kind}): ${e.message.slice(0, 200)}`);
      else log.warn(`${cand.provider}/${cand.model} unavailable (${e.kind}: ${e.message.slice(0, 140)})`);
    }
  }
  if (!V) {
    // Every independent verifier failed. This pass is an INTERNAL quality tool that adds nothing
    // visible to the report, so skipping it beats discarding a complete, already-validated analysis.
    // The reason is logged AND recorded in verification.json, so a real bug is still loud.
    const why = `every independent verifier failed (last: ${lastErr?.kind || "error"} — ${String(lastErr?.message || "").slice(0, 160)})`;
    log.err(`${why} — SKIPPING the audit rather than failing an otherwise complete run`);
    await writeSkipped(why, null);
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
