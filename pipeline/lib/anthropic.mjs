// anthropic.mjs — optional SECOND provider for the verification pass, so the audit can be a true
// cross-provider check (a different model family judging the first model's transcript claims).
// Structured output is forced via a single tool with an input_schema + tool_choice. Only used when
// ANTHROPIC_API_KEY is set; otherwise the verifier falls back to a different OpenAI model.

export const DEFAULT_VERIFY_MODEL_ANTHROPIC = "claude-sonnet-5"; // strong, independent judge; override via VERIFY_MODEL

// Rough per-1M-token USD prices for the cost estimate (input, output). Estimate only.
const PRICES = {
  "claude-sonnet-5": [3.0, 15.0],
  "claude-haiku-4-5": [1.0, 5.0],
};

/**
 * One structured completion via the Anthropic Messages API. `messages` uses OpenAI-style
 * [{role:'system'|'user', content}] — the system turn is lifted into the top-level `system` field.
 * Returns { data, usage, model }. Throws on HTTP error / missing tool_use.
 */
export async function callAnthropicStructured({ apiKey, model, messages, schema, schemaName = "extract", temperature = 0.1, maxTokens = 4000, timeoutMs = 180000 }) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
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
        tools: [{ name: schemaName, description: "Return the audit result in this exact shape.", input_schema: schema }],
        tool_choice: { type: "tool", name: schemaName },
      }),
    });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 600)}`);
  const j = await res.json();
  const toolUse = (j.content || []).find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Anthropic returned no tool_use block");
  const usage = { prompt_tokens: j.usage?.input_tokens || 0, completion_tokens: j.usage?.output_tokens || 0 };
  return { data: toolUse.input, usage, model: j.model || model };
}

/** Estimate an Anthropic call's cost from token usage (same shape as openai.mjs → estimateCost). */
export function estimateAnthropicCost(usage, model) {
  const key = PRICES[model] ? model : Object.keys(PRICES).find((k) => (model || "").startsWith(k));
  const [pin, pout] = PRICES[key] || [3.0, 15.0];
  const inTok = usage?.prompt_tokens || 0;
  const outTok = usage?.completion_tokens || 0;
  return { inTok, outTok, usd: inTok / 1e6 * pin + outTok / 1e6 * pout, priced_as: key || "claude-sonnet-5(default)" };
}
