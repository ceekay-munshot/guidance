// bedrock.mjs — Claude via the AWS Bedrock Runtime Converse API. This is the ENTIRE Claude/Bedrock
// code path: used only when LLM_PROVIDER=claude (see pipeline/lib/llm.mjs, the single toggle). No
// other file imports this module — delete this file + pipeline/lib/llm.mjs, and point each caller's
// import back at pipeline/lib/openai.mjs, to remove the Claude path completely.
//
// Mirrors pipeline/lib/openai.mjs's callStructured contract exactly: returns { data, usage, model }
// with usage in OpenAI's { prompt_tokens, completion_tokens } shape, so callers (and their output)
// can't tell providers apart. Structured output is forced via a single tool + toolChoice (Bedrock's
// Converse API has no json_schema/strict mode like OpenAI's).
//
// Auth: Bedrock API keys (bearer tokens) via `Authorization: Bearer <key>` — NOT SigV4 request
// signing. See https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html
//
// ASSUMPTION (flagged for verification against the real AWS account — see PR description):
// region us-east-1, model us.anthropic.claude-sonnet-4-5-20250929-v1:0. Override via BEDROCK_REGION
// / BEDROCK_MODEL_ID env vars if the account uses a different region/model.

export const DEFAULT_MODEL_BEDROCK = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
export const DEFAULT_REGION_BEDROCK = "us-east-1";

/** Rough per-1M-token USD prices for the cost estimate (input, output). Estimate only — update as needed. */
const PRICES = {
  "anthropic.claude-sonnet-4-5-20250929-v1:0": [3.0, 15.0],
};

/**
 * One structured-output completion via Bedrock's Converse API. `messages` uses OpenAI-style
 * [{role:'system'|'user', content}] — the system turn is lifted into the top-level `system` field,
 * same convention as pipeline/lib/anthropic.mjs.
 * Returns { data, usage, model }. Throws on HTTP error / missing toolUse / truncated output.
 */
export async function callBedrockStructured({ apiKey, model, region, messages, schema, schemaName = "extract", temperature = 0.1, maxTokens = 8000, timeoutMs = 180000 }) {
  const modelId = model || DEFAULT_MODEL_BEDROCK;
  const awsRegion = region || process.env.BEDROCK_REGION || DEFAULT_REGION_BEDROCK;
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: [{ text: m.content }] }));

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`https://bedrock-runtime.${awsRegion}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        messages: turns,
        ...(system ? { system: [{ text: system }] } : {}),
        inferenceConfig: { temperature, maxTokens },
        toolConfig: {
          tools: [{ toolSpec: { name: schemaName, description: "Return the result in this exact shape.", inputSchema: { json: schema } } }],
          toolChoice: { tool: { name: schemaName } },
        },
      }),
    });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`Bedrock HTTP ${res.status}: ${(await res.text()).slice(0, 600)}`);
  const j = await res.json();
  if (j.stopReason === "max_tokens") throw new Error("model output truncated (raise maxTokens)");
  const content = j.output?.message?.content || [];
  const toolUse = content.find((b) => b.toolUse)?.toolUse;
  if (!toolUse) throw new Error("Bedrock returned no tool_use block");
  const usage = { prompt_tokens: j.usage?.inputTokens || 0, completion_tokens: j.usage?.outputTokens || 0 };
  return { data: toolUse.input, usage, model: modelId };
}

/** Estimate the call's cost from token usage (same shape as openai.mjs → estimateCost). */
export function estimateBedrockCost(usage, model) {
  const key = PRICES[model] ? model : Object.keys(PRICES).find((k) => (model || "").includes(k));
  const [pin, pout] = PRICES[key] || [3.0, 15.0];
  const inTok = usage?.prompt_tokens || 0;
  const outTok = usage?.completion_tokens || 0;
  return { inTok, outTok, usd: inTok / 1e6 * pin + outTok / 1e6 * pout, priced_as: key || "claude-sonnet-4.5-bedrock(default)" };
}
