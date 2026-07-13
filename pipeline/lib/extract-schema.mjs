// extract-schema.mjs — the JSON schema OpenAI structured outputs MUST return, plus the controlled
// vocabularies the prompt references. This is the LLM's output shape (B + C.1–C.5, C.7, C.8);
// `source` is NOT asked of the model — it's injected deterministically at assembly time.

// C.5 tags — the client's exact list.
export const CLASSIFICATION_TAGS = [
  "Compounder", "Cyclical", "Emerging leader", "Execution miss", "Governance risk",
  "J-curve", "Margin compression", "No growth", "Operating leverage", "Turnaround", "Unclear thesis",
];

// C.4 checklist — the triggers to flag Yes/No/Partial.
export const THESIS_TRIGGERS = [
  "M&A", "Capex announcement", "Debt reduction", "Geographic expansion", "Market share gain",
  "New product / segment", "Order book / backlog surge", "Regulatory approval",
];

// C.2 themes to cover (stance + evidence for each that applies).
export const THEME_TOPICS = [
  "commodity / input-cost trend", "end-demand", "competitive intensity",
  "regulatory / policy", "capacity utilization", "explicit tailwind/headwind",
];

const strObj = (props, required) => ({ type: "object", additionalProperties: false, required, properties: props });
const arr = (items) => ({ type: "array", items });

/** OpenAI json_schema (strict): every property required, additionalProperties:false, nullable via type arrays. */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["about", "concall"],
  properties: {
    about: strObj(
      {
        products: arr({ type: "string" }),
        segments: arr({ type: "string" }),
        segment_reported: { type: "boolean" },
        revenue_mix: arr(strObj({ segment: { type: "string" }, pct: { type: "number" } }, ["segment", "pct"])),
        // ebitda_margin null = "not disclosed" (assembly converts it); never invent a number.
        margin_by_segment: arr(strObj({ segment: { type: "string" }, ebitda_margin: { type: ["number", "null"] } }, ["segment", "ebitda_margin"])),
      },
      ["products", "segments", "segment_reported", "revenue_mix", "margin_by_segment"]
    ),
    concall: strObj(
      {
        guidance: arr(strObj(
          {
            metric: { type: "string" },
            horizon: { type: "string" },
            statement: { type: "string" },
            type: { type: "string", enum: ["hard", "directional"] },
            value: { type: ["string", "null"] },
            // Verbatim sentence from the transcript/PPT backing this (copy word-for-word so it is
            // Ctrl+F-able). null when no single clean sentence backs it. Verified against the source.
            quote: { type: ["string", "null"] },
          },
          ["metric", "horizon", "statement", "type", "value", "quote"]
        )),
        themes: arr(strObj(
          { theme: { type: "string" }, stance: { type: "string", enum: ["Positive", "Negative", "Neutral"] }, evidence: { type: "string" }, quote: { type: ["string", "null"] } },
          ["theme", "stance", "evidence", "quote"]
        )),
        tone_shift_vs_last_quarter: { type: "string" },
        expansion_flags: arr(strObj(
          { metric: { type: "string" }, yoy_delta: { type: ["string", "null"] }, qoq_delta: { type: ["string", "null"] }, driver: { type: "string" } },
          ["metric", "yoy_delta", "qoq_delta", "driver"]
        )),
        thesis_triggers: arr(strObj(
          { trigger: { type: "string" }, flag: { type: "string", enum: ["Yes", "No", "Partial"] }, evidence: { type: "string" }, quote: { type: ["string", "null"] } },
          ["trigger", "flag", "evidence", "quote"]
        )),
        classification: arr(strObj(
          { tag: { type: "string", enum: CLASSIFICATION_TAGS }, justification: { type: "string" } },
          ["tag", "justification"]
        )),
        management_tone: arr(strObj(
          { theme: { type: "string" }, tone: { type: "string", enum: ["Confident", "Neutral", "Defensive"] }, anchor: { type: "string" } },
          ["theme", "tone", "anchor"]
        )),
        analyst_tone: strObj(
          { hot_themes: arr({ type: "string" }), qa_tenor: { type: "string", enum: ["skeptical", "constructive", "perfunctory"] } },
          ["hot_themes", "qa_tenor"]
        ),
      },
      ["guidance", "themes", "tone_shift_vs_last_quarter", "expansion_flags", "thesis_triggers", "classification", "management_tone", "analyst_tone"]
    ),
  },
};
