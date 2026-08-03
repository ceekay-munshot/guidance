// llm.mjs — the ONE toggle between the OpenAI path (default, pipeline/lib/openai.mjs) and the
// Claude/Bedrock path (pipeline/lib/bedrock.mjs). Set LLM_PROVIDER=claude to route the main
// structured-completion calls to Bedrock; leave it unset (or "openai") and every call site behaves
// exactly as it does today — this file just re-dispatches to openai.mjs unchanged.
//
// To remove the Claude path later: delete this file + pipeline/lib/bedrock.mjs, and change each
// caller's import back to "./lib/openai.mjs" (undoing the small toggle edits in each pipeline/*.mjs
// entrypoint). pipeline/lib/openai.mjs itself is never touched by any of this.

import { callStructured, estimateCost, DEFAULT_MODEL } from "./openai.mjs";
import { callBedrockStructured, estimateBedrockCost, DEFAULT_MODEL_BEDROCK } from "./bedrock.mjs";

export const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai").trim().toLowerCase();
export const isClaude = LLM_PROVIDER === "claude";

/** Human label for log lines — "OpenAI" today, "Claude (Bedrock)" once toggled. */
export const LLM_LABEL = isClaude ? "Claude (Bedrock)" : "OpenAI";

/** The env var name callers should report as missing in their error messages. */
export function llmApiKeyEnvName() {
  return isClaude ? "CLAUDE_BEDROCK_KEY" : "OPENAI_API_KEY";
}

/** The API key for whichever provider is toggled on. */
export function llmApiKey() {
  return isClaude ? process.env.CLAUDE_BEDROCK_KEY : process.env.OPENAI_API_KEY;
}

/** The model for whichever provider is toggled on — OPENAI_MODEL / BEDROCK_MODEL_ID override, same pattern as before. */
export function llmModel() {
  return isClaude ? (process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_BEDROCK) : (process.env.OPENAI_MODEL || DEFAULT_MODEL);
}

/** Structured completion — routes to whichever provider is toggled on. Identical { data, usage, model } shape either way. */
export async function callLLMStructured(opts) {
  return isClaude ? callBedrockStructured(opts) : callStructured(opts);
}

/** Cost estimate — routes to whichever provider is toggled on. Identical { inTok, outTok, usd, priced_as } shape either way. */
export function estimateLLMCost(usage, model) {
  return isClaude ? estimateBedrockCost(usage, model) : estimateCost(usage, model);
}
