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
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callStructured, estimateCost, DEFAULT_MODEL } from "./openai.mjs";
import { callAnthropicStructured, estimateAnthropicCost } from "./anthropic.mjs";
import { log } from "./util.mjs";

/** Anthropic model used when it stands in for OpenAI on the main extraction steps. */
export const DEFAULT_FALLBACK_MODEL_ANTHROPIC = "claude-sonnet-5";

/** A provider failure means the provider is unusable — try the next one. Our own bad request doesn't. */
const FAILOVER_KINDS = new Set(["quota", "auth", "rate_limit", "server", "network"]);

/**
 * Providers proven dead are remembered for the REST OF THE JOB, in a file.
 *
 * Each workflow step is its own `node` process, so an in-memory flag would forget between Extract,
 * Research, Model and Finalize — and a persistently hanging provider would be re-probed (and its
 * whole retry budget re-spent) five times over, which can exceed the job's `timeout-minutes: 20`
 * before the fallback ever publishes. The workspace persists across steps, so a marker file here
 * makes "this provider is dead" a fact for the whole run: the first step pays to discover it, every
 * later step fails straight over.
 *
 * Only DURABLE failures are recorded — out of credit, rejected credentials, or a provider that
 * burned its entire budget without answering. A passing rate-limit is not held against it.
 */
const OUT_ROOT = fileURLToPath(new URL("../out/", import.meta.url));
const HEALTH_FILE = join(OUT_ROOT, ".provider-health.json");

/**
 * How long a mark stays valid. CI checks out fresh so `pipeline/out/` is empty, but a LOCAL checkout
 * keeps it between analyses (it's gitignored, not cleaned) — so without an expiry, one run that hit
 * an expired key would go on quietly routing around that provider forever. fetch-company clears the
 * file at the start of every run; this TTL is the backstop for when a step is run on its own, and it
 * comfortably exceeds the job's own 20-minute ceiling.
 */
const HEALTH_TTL_MS = 30 * 60 * 1000;

function readUnhealthy() {
  let raw;
  try { raw = JSON.parse(readFileSync(HEALTH_FILE, "utf8")) || {}; } catch { return {}; }
  const fresh = {};
  for (const [provider, v] of Object.entries(raw)) {
    const age = Date.now() - Date.parse(v?.at || "");
    if (Number.isFinite(age) && age >= 0 && age < HEALTH_TTL_MS) fresh[provider] = v;
  }
  return fresh;
}

/** Record a provider as unusable for the remainder of this run. Best-effort — never throws. */
export function markProviderUnhealthy(provider, reason) {
  try {
    mkdirSync(OUT_ROOT, { recursive: true });
    const cur = readUnhealthy();
    cur[provider] = { reason, at: new Date().toISOString() };
    writeFileSync(HEALTH_FILE, JSON.stringify(cur, null, 2));
  } catch { /* best-effort */ }
}

/**
 * Forget every mark. Called by fetch-company at the START of a run, so provider health is scoped to
 * one analysis: a key repaired since the last local run is given a fresh chance rather than being
 * written off by a stale file. Best-effort — never throws.
 */
export function clearProviderHealth() {
  try { rmSync(HEALTH_FILE, { force: true }); } catch { /* best-effort */ }
}

/** A durable failure is one no later step should pay to rediscover. */
const isDurable = (e) => e.kind === "quota" || e.kind === "auth" || !!e.budgetSpent;

/**
 * The providers this run can use, in preference order. OpenAI stays primary (it is what every prompt
 * was tuned against); Anthropic is the standby. Providers already proven dead this run are dropped.
 */
export function availableProviders() {
  const dead = readUnhealthy();
  const out = [];
  if (process.env.OPENAI_API_KEY) {
    out.push({ provider: "openai", key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || DEFAULT_MODEL });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    out.push({ provider: "anthropic", key: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL || DEFAULT_FALLBACK_MODEL_ANTHROPIC });
  }
  // Keep a dead provider ONLY if it's all we have — a doomed attempt still beats no attempt, and it
  // produces the accurate error message rather than a bare "no provider configured".
  const alive = out.filter((p) => !dead[p.provider]);
  return alive.length ? alive : out;
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
      // Out of credit / bad key / burned its whole budget → don't make the next four steps
      // rediscover that at 90s a piece.
      if (isDurable(e)) {
        markProviderUnhealthy(p.provider, `${e.kind}: ${e.message.slice(0, 160)}`);
        log.warn(`${p.provider} marked unhealthy for the rest of this run (${e.kind})`);
      }
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
