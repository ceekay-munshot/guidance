// research-schema.mjs — the strict JSON schemas the Step 8 LLM calls must return, plus the
// controlled vocabularies the prompts reference. Two shapes:
//   1. RISK_THESIS_JSON_SCHEMA — C.6 risks (web) + Section D thesis / anti-thesis.
//   2. VERIFY_JSON_SCHEMA       — the second-model audit verdicts over Step 7's transcript claims.
// `source` on risks is injected as "Web" at assembly time; thesis/anti-thesis carry their own
// per-point Web/Est. source (the model picks, constrained to the enum).

// Risk buckets we look for OFF the call (her rule: risks come from the web, not the transcript).
export const RISK_TYPES = [
  "Litigation", "Regulatory", "Promoter / pledge", "Related-party", "Rating action",
  "Governance", "Concentration", "Balance sheet", "Demand", "Competition",
];

// Verdict + confidence vocabularies for the verification audit.
export const VERIFY_VERDICTS = ["supported", "partial", "unsupported"];
export const VERIFY_CONFIDENCE = ["high", "medium", "low"];

const strObj = (props, required) => ({ type: "object", additionalProperties: false, required, properties: props });
const arr = (items) => ({ type: "array", items });

/**
 * OpenAI json_schema (strict) for the risk + thesis extraction. Every property required,
 * additionalProperties:false. `source` is omitted on risks (injected as "Web"); thesis /
 * anti-thesis carry Web/Est. The `falsifier` is required here and further enforced (non-empty)
 * at assembly — a point with no real falsifier is dropped.
 */
export const RISK_THESIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["risks", "thesis", "anti_thesis"],
  properties: {
    // C.6 — risks NOT volunteered on the call. `risk` text should end with a real "(Source: URL)".
    risks: arr(strObj(
      { risk: { type: "string" }, type: { type: "string" } },
      ["risk", "type"]
    )),
    // D — bull case. Each point falsifiable; source Web (external) or Est. (our inference).
    thesis: arr(strObj(
      { point: { type: "string" }, falsifier: { type: "string" }, source: { type: "string", enum: ["Web", "Est."] } },
      ["point", "falsifier", "source"]
    )),
    // D — bear case, symmetric.
    anti_thesis: arr(strObj(
      { point: { type: "string" }, falsifier: { type: "string" }, source: { type: "string", enum: ["Web", "Est."] } },
      ["point", "falsifier", "source"]
    )),
  },
};

/**
 * OpenAI json_schema (strict) for the verification audit. The model returns one verdict per
 * claim we hand it (referenced by the stable `ref` we assign). `category` ties the verdict back
 * to the slice it belongs to so assembly can prune the right array.
 */
export const VERIFY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: arr(strObj(
      {
        ref: { type: "string" },
        category: { type: "string", enum: ["guidance", "expansion_flag", "about"] },
        claim: { type: "string" },
        verdict: { type: "string", enum: VERIFY_VERDICTS },
        confidence: { type: "string", enum: VERIFY_CONFIDENCE },
        note: { type: "string" },
      },
      ["ref", "category", "claim", "verdict", "confidence", "note"]
    )),
  },
};
