// anthropic.mjs — the optional SECOND provider. It plays two roles, both gated on ANTHROPIC_API_KEY:
//   • the verification pass, so the audit is a true cross-provider check (a different model family
//     judging the first model's transcript claims); without the key the verifier uses another OpenAI model.
//   • the FAILOVER for every LLM step (see lib/llm.mjs) when OpenAI is out of credit or unreachable.
// Structured output is forced via a single tool with an input_schema + tool_choice. Failures are
// classified by openai.mjs's classifyLlmError so callers branch identically across providers.

import { classifyLlmError, PROVIDER_BUDGET_MS } from "./openai.mjs";

export const DEFAULT_VERIFY_MODEL_ANTHROPIC = "claude-sonnet-5"; // strong, independent judge; override via VERIFY_MODEL

// Rough per-1M-token USD prices for the cost estimate (input, output). Estimate only.
const PRICES = {
  "claude-sonnet-5": [3.0, 15.0],
  "claude-haiku-4-5": [1.0, 5.0],
};

/** Backoff + per-provider wall-clock budget for retries — mirrors openai.mjs (see PROVIDER_BUDGET_MS). */
const RETRY_DELAYS_MS = [2000, 6000, 15000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One structured completion via the Anthropic Messages API, retrying TRANSIENT failures (rate limit,
 * 5xx, network) with backoff. `messages` uses OpenAI-style [{role:'system'|'user', content}] — the
 * system turn is lifted into the top-level `system` field. Returns { data, usage, model }. Throws a
 * classified error (`.kind`, `.retryable`, `.userMessage`) on HTTP error / missing tool_use.
 */
export async function callAnthropicStructured({ apiKey, model, messages, schema, schemaName = "extract", temperature = 0.1, maxTokens = 4000, timeoutMs = 180000, budgetMs = PROVIDER_BUDGET_MS, retries = RETRY_DELAYS_MS.length, onRetry = null }) {
  const startedAt = Date.now();
  const leftMs = () => budgetMs - (Date.now() - startedAt);
  for (let attempt = 0; ; attempt++) {
    const attemptTimeout = Math.max(1000, Math.min(timeoutMs, leftMs()));
    try {
      return await attemptAnthropic({ apiKey, model, messages, schema, schemaName, temperature, maxTokens, timeoutMs: attemptTimeout });
    } catch (e) {
      if (!e.retryable || attempt >= retries) throw e;
      const wait = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      if (leftMs() <= wait) { e.budgetSpent = true; e.message += ` (gave up: ${Math.round(budgetMs / 1000)}s provider budget spent)`; throw e; }
      onRetry?.({ attempt: attempt + 1, of: retries, waitMs: wait, error: e });
      await sleep(wait);
    }
  }
}

/** An Error carrying openai.mjs's classification, so callers branch identically across providers. */
function anthropicError(message, { status, body }) {
  const c = classifyLlmError({ provider: "anthropic", status, body });
  const e = new Error(message);
  e.provider = "anthropic";
  e.status = status;
  e.kind = c.kind;
  e.retryable = c.retryable;
  e.userMessage = c.userMessage;
  return e;
}

/**
 * One attempt. Throws a classified error on any failure.
 *
 * As in openai.mjs, the abort controller stays armed until the response BODY is consumed — `fetch()`
 * resolves on headers, so clearing the timer there would let a mid-body stall hang past the
 * per-provider budget and defeat the retry/failover machinery.
 */
async function attemptAnthropic({ apiKey, model, messages, schema, schemaName, temperature, maxTokens, timeoutMs }) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const timedOut = (what) => anthropicError(`Anthropic ${what} timed out after ${timeoutMs}ms`, { status: 0, body: "" });
  try {
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          system,
          messages: turns,
          tools: [{ name: schemaName, description: "Return the result in this exact shape.", input_schema: schema }],
          tool_choice: { type: "tool", name: schemaName },
        }),
      });
    } catch (e) {
      if (e.name === "AbortError") throw timedOut("request");
      throw anthropicError(`Anthropic request failed: ${e.message}`, { status: 0, body: "" });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw anthropicError(`Anthropic HTTP ${res.status}: ${body.slice(0, 600)}`, { status: res.status, body });
    }

    let j;
    try {
      j = await res.json();
    } catch (e) {
      if (e.name === "AbortError") throw timedOut("response body");
      throw anthropicError(`Anthropic returned an unreadable body: ${e.message}`, { status: 422, body: "" });
    }

    const toolUse = (j.content || []).find((b) => b.type === "tool_use");
    if (!toolUse) throw anthropicError("Anthropic returned no tool_use block", { status: 422, body: "" });
    const usage = { prompt_tokens: j.usage?.input_tokens || 0, completion_tokens: j.usage?.output_tokens || 0 };
    return { data: toolUse.input, usage, model: j.model || model };
  } finally {
    clearTimeout(t); // only now — the body is read (or the attempt has failed)
  }
}

/** Estimate an Anthropic call's cost from token usage (same shape as openai.mjs → estimateCost). */
export function estimateAnthropicCost(usage, model) {
  const key = PRICES[model] ? model : Object.keys(PRICES).find((k) => (model || "").startsWith(k));
  const [pin, pout] = PRICES[key] || [3.0, 15.0];
  const inTok = usage?.prompt_tokens || 0;
  const outTok = usage?.completion_tokens || 0;
  return { inTok, outTok, usd: inTok / 1e6 * pin + outTok / 1e6 * pout, priced_as: key || "claude-sonnet-5(default)" };
}
