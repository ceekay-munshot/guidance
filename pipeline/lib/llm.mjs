// llm.mjs — ONE place where every LLM step decides which provider to call, how hard to retry, and
// what to tell the user when the call is impossible.
//
// Why this exists: on 2026-08-01 the OpenAI account ran out of credit. Step 6 had already fetched
// Neuland Laboratories' Q4FY26 transcript (48k chars) and deck (27k chars) and passed its self-check
// — then Step 7's single un-retried call returned HTTP 429 `credit_balance_exhausted`, the job died,
// and the client was told "a source (financials, transcript or deck) may have been temporarily
// unavailable". Every part of that sentence was wrong. This module fixes the three things behind it:
//
//   1. TRANSIENT failures (rate limit, 5xx, network blip) are retried with backoff instead of
//      killing a run that would have succeeded seconds later.
//   2. A configured SECOND provider takes over when the first is out of credit or unreachable, so
//      one provider's billing state doesn't decide whether the product works.
//   3. The reason that reaches the user is the REAL one — written to pipeline/out/<slug>/error.txt,
//      which kv-put.mjs already prefers over the workflow's generic catch-all message.
//
// Providers are tried in order: OpenAI (OPENAI_API_KEY), then Anthropic (ANTHROPIC_API_KEY). Both are
// optional individually; at least one must be set. With only OPENAI_API_KEY configured — the current
// production setup — behaviour is unchanged apart from the retries.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callStructured, estimateCost, DEFAULT_MODEL } from "./openai.mjs";
import { callAnthropicStructured, estimateAnthropicCost } from "./anthropic.mjs";
import { log } from "./util.mjs";

/** Anthropic model used when it stands in for OpenAI on the main extraction steps. */
export const DEFAULT_FALLBACK_MODEL_ANTHROPIC = "claude-sonnet-5";

/** A provider failure means the provider is unusable — try the next one. Our own bad request doesn't. */
const FAILOVER_KINDS = new Set(["quota", "auth", "rate_limit", "server", "network"]);

/**
 * The providers this run can use, in preference order. OpenAI stays primary (it is what every prompt
 * was tuned against); Anthropic is the standby.
 */
export function availableProviders() {
  const out = [];
  if (process.env.OPENAI_API_KEY) {
    out.push({ provider: "openai", key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || DEFAULT_MODEL });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    out.push({ provider: "anthropic", key: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL || DEFAULT_FALLBACK_MODEL_ANTHROPIC });
  }
  return out;
}

/** Cost estimate for whichever provider actually answered. */
export function estimateCostFor(provider, usage, model) {
  return provider === "anthropic" ? estimateAnthropicCost(usage, model) : estimateCost(usage, model);
}

/**
 * One structured-output call, with retries inside each provider and failover between them.
 * Returns { data, usage, model, provider }. Throws the LAST error, carrying `.userMessage`.
 */
export async function callModel({ messages, schema, schemaName, maxTokens = 8000, temperature = 0.1, purpose = "the analysis" }) {
  const providers = availableProviders();
  if (!providers.length) {
    const e = new Error("no LLM provider configured — set OPENAI_API_KEY (or ANTHROPIC_API_KEY)");
    e.kind = "config";
    e.userMessage = "Our analysis engine isn't configured. Please try again shortly.";
    throw e;
  }

  let lastErr = null;
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const onRetry = ({ attempt, of, waitMs, error }) =>
      log.warn(`${p.provider} ${error.kind} (${error.status || "network"}) — retry ${attempt}/${of} in ${waitMs / 1000}s`);
    try {
      log.step(`Calling ${p.provider} (${p.model}) for ${purpose}…`);
      const r = await (p.provider === "anthropic"
        ? callAnthropicStructured({ apiKey: p.key, model: p.model, messages, schema, schemaName, temperature, maxTokens, onRetry })
        : callStructured({ apiKey: p.key, model: p.model, messages, schema, schemaName, temperature, maxTokens, onRetry }));
      if (i > 0) log.ok(`${p.provider} answered after ${providers[0].provider} was unavailable`);
      return { ...r, provider: p.provider };
    } catch (e) {
      lastErr = e;
      const next = providers[i + 1];
      if (next && FAILOVER_KINDS.has(e.kind)) {
        log.warn(`${p.provider} unavailable (${e.kind}): ${e.message.slice(0, 200)}`);
        log.warn(`failing over to ${next.provider} (${next.model})`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Record WHY a step failed where the client can see it. kv-put.mjs reads
 * pipeline/out/<slug>/error.txt and prefers it over the workflow's generic message, so this is what
 * turns "a source may have been temporarily unavailable" into the actual reason. Best-effort: a
 * failure to write the reason must never mask the failure it is describing.
 */
export async function writeErrorReason(dir, message) {
  if (!dir || !message) return;
  try { await writeFile(join(dir, "error.txt"), String(message)); } catch { /* best-effort */ }
}

/**
 * Log a failed LLM step in full and leave the user-facing reason behind. Returns nothing; the caller
 * sets its own exit code so the workflow still goes red.
 */
export async function reportLlmFailure(dir, step, err) {
  log.err(`${step} failed [${err.kind || "error"}]: ${err.message}`);
  if (err.kind === "quota") {
    log.err("the provider account is out of credit — top it up, or set ANTHROPIC_API_KEY so the pipeline can fail over to a second provider");
  }
  await writeErrorReason(dir, err.userMessage || "We couldn't finish this analysis. Please try again shortly.");
}
