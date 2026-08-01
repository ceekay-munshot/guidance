// openai.mjs — thin OpenAI Chat Completions client using STRUCTURED OUTPUTS (json_schema strict),
// so the model must return our exact shape. The only network-touching module in Step 7.

export const DEFAULT_MODEL = "gpt-4.1"; // current capable flagship, large context; override via OPENAI_MODEL

/** Rough per-1M-token USD prices for the cost estimate (input, output). Estimate only — update as needed. */
const PRICES = {
  "gpt-4.1": [2.0, 8.0],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4o": [2.5, 10.0],
  "gpt-4o-mini": [0.15, 0.6],
};

/** Backoff before each retry of a TRANSIENT failure. */
const RETRY_DELAYS_MS = [2000, 6000, 15000];

/**
 * Hard ceiling on the WALL-CLOCK time one provider may consume across all of its attempts.
 *
 * The backoff sleeps only add ~23s, but a HUNG connection — precisely the failure the retries exist
 * to survive — burns the full per-attempt timeout every time. Four 180s attempts would pin a single
 * step for ~12m before the fallback provider is even tried, and the job's `timeout-minutes: 20`
 * has to cover document fetching plus all five LLM stages. This budget bounds it: once spent, the
 * provider is declared unusable and callModel moves on.
 *
 * The budget is PER CALL, and each of the five steps is its own process — so it is paired with the
 * cross-step health marker in llm.mjs. A provider that spends its whole budget is recorded as dead
 * for the run, and later steps fail over immediately instead of re-paying 90s each. Worst case for a
 * silently hanging primary is therefore ~90s once, not 90s × 5.
 */
export const PROVIDER_BUDGET_MS = 90000; // 90s — five LLM steps must all fit inside one 20-min job
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Classify a provider failure so callers can retry only what is worth retrying and tell the user the
 * truth about the rest.
 *
 * The distinction that matters most is inside 429: it means either "slow down" (transient — retry) or
 * "this account is out of credit" (permanent until someone tops it up). The pipeline used to collapse
 * both into one opaque failure and report "a source (financials, transcript or deck) may have been
 * temporarily unavailable", which sent people hunting for a transcript that had downloaded perfectly.
 *
 * → { kind, retryable, userMessage }
 */
export function classifyLlmError({ provider = "openai", status = 0, body = "" } = {}) {
  const text = String(body || "");
  const outOfCredit = /insufficient_quota|credit_balance_exhausted|billing_not_active|no credits remaining|exceeded your current quota/i.test(text);

  if (status === 429 && outOfCredit) {
    return {
      kind: "quota",
      retryable: false, // no amount of waiting adds credit
      userMessage: "Our analysis engine has hit its API usage limit. The company's financials and earnings documents were fetched fine — please try again shortly.",
    };
  }
  if (status === 429) {
    return { kind: "rate_limit", retryable: true, userMessage: "Our analysis engine is busy right now. Please try again in a few minutes." };
  }
  if (status === 401 || status === 403) {
    return { kind: "auth", retryable: false, userMessage: "Our analysis engine is temporarily unavailable. Please try again shortly." };
  }
  if (status >= 500) {
    return { kind: "server", retryable: true, userMessage: `The ${provider} analysis provider is temporarily unavailable. Please try again shortly.` };
  }
  if (status === 0) {
    return { kind: "network", retryable: true, userMessage: "We couldn't reach our analysis provider. Please try again shortly." };
  }
  // 400/404/422 — our request is wrong (bad schema, unknown model). Retrying repeats the same mistake.
  return { kind: "bad_request", retryable: false, userMessage: "We couldn't finish this analysis. Please try again shortly." };
}

/** An Error carrying the classification, so every caller can branch without re-parsing the message. */
function llmError(message, { provider, status, body }) {
  const c = classifyLlmError({ provider, status, body });
  const e = new Error(message);
  e.provider = provider;
  e.status = status;
  e.kind = c.kind;
  e.retryable = c.retryable;
  e.userMessage = c.userMessage;
  return e;
}

/** One attempt. Throws a classified error (see llmError) on any failure. */
async function attemptStructured({ apiKey, model, messages, schema, schemaName, temperature, maxTokens, timeoutMs }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages,
        response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      }),
    });
  } catch (e) {
    // Transport-level failure (DNS, reset, our own abort on timeout) — status 0 → retryable.
    throw llmError(`OpenAI request failed: ${e.name === "AbortError" ? `timed out after ${timeoutMs}ms` : e.message}`, { provider: "openai", status: 0, body: "" });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw llmError(`OpenAI HTTP ${res.status}: ${body.slice(0, 600)}`, { provider: "openai", status: res.status, body });
  }
  const j = await res.json();
  const choice = j.choices?.[0];
  // Content-level problems are OUR request's fault (prompt/schema/token budget) — not retryable.
  if (choice?.message?.refusal) throw llmError(`model refusal: ${choice.message.refusal}`, { provider: "openai", status: 422, body: "" });
  if (choice?.finish_reason === "length") throw llmError("model output truncated (raise maxTokens)", { provider: "openai", status: 422, body: "" });
  const content = choice?.message?.content;
  if (!content) throw llmError("empty model response", { provider: "openai", status: 422, body: "" });
  return { data: JSON.parse(content), usage: j.usage || {}, model: j.model || model };
}

/**
 * One structured-output completion, retrying TRANSIENT failures (rate limit, 5xx, network) with
 * backoff. Returns { data, usage, model }. Throws a classified error (`.kind`, `.retryable`,
 * `.userMessage`) on model refusal / unparseable content / a failure worth surfacing.
 */
export async function callStructured({ apiKey, model, messages, schema, schemaName = "extract", temperature = 0.1, maxTokens = 8000, timeoutMs = 180000, budgetMs = PROVIDER_BUDGET_MS, retries = RETRY_DELAYS_MS.length, onRetry = null }) {
  const startedAt = Date.now();
  const leftMs = () => budgetMs - (Date.now() - startedAt);
  for (let attempt = 0; ; attempt++) {
    // Never let one attempt outlive the budget — a hang is capped by whatever time is left.
    const attemptTimeout = Math.max(1000, Math.min(timeoutMs, leftMs()));
    try {
      return await attemptStructured({ apiKey, model, messages, schema, schemaName, temperature, maxTokens, timeoutMs: attemptTimeout });
    } catch (e) {
      if (!e.retryable || attempt >= retries) throw e;
      const wait = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      // budgetSpent tells callModel this provider is dead for the run, not just for this call.
      if (leftMs() <= wait) { e.budgetSpent = true; e.message += ` (gave up: ${Math.round(budgetMs / 1000)}s provider budget spent)`; throw e; }
      onRetry?.({ attempt: attempt + 1, of: retries, waitMs: wait, error: e });
      await sleep(wait);
    }
  }
}

/** Estimate the call's cost from token usage. */
export function estimateCost(usage, model) {
  const key = PRICES[model] ? model : Object.keys(PRICES).find((k) => (model || "").startsWith(k));
  const [pin, pout] = PRICES[key] || [2.0, 8.0];
  const inTok = usage?.prompt_tokens || 0;
  const outTok = usage?.completion_tokens || 0;
  return { inTok, outTok, usd: inTok / 1e6 * pin + outTok / 1e6 * pout, priced_as: key || "gpt-4.1(default)" };
}

/** Rough token estimate for guardrails (≈4 chars/token for English). */
export const estTokens = (chars) => Math.ceil(chars / 4);
