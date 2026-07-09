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

/**
 * One structured-output completion. Returns { data, usage, model }.
 * Throws on HTTP error / model refusal / unparseable content.
 */
export async function callStructured({ apiKey, model, messages, schema, schemaName = "extract", temperature = 0.1, maxTokens = 8000, timeoutMs = 180000 }) {
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
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 600)}`);
  const j = await res.json();
  const choice = j.choices?.[0];
  if (choice?.message?.refusal) throw new Error(`model refusal: ${choice.message.refusal}`);
  if (choice?.finish_reason === "length") throw new Error("model output truncated (raise maxTokens)");
  const content = choice?.message?.content;
  if (!content) throw new Error("empty model response");
  return { data: JSON.parse(content), usage: j.usage || {}, model: j.model || model };
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
