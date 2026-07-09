// model-schema.mjs — strict OpenAI schemas for Step 9. The LLM supplies the ASSUMPTIONS + prose;
// the SCRIPT does all the arithmetic (rows, multiples) deterministically. Two shapes:
//   1. MODEL_JSON_SCHEMA    — E assumptions/drivers + G conviction/triggers (numbers are % levers only).
//   2. TAKEAWAYS_JSON_SCHEMA — the final 5–7 key_takeaways synthesis across B–G.
// Nullable fields use type arrays; every property is required (strict mode).

const strObj = (props, required) => ({ type: "object", additionalProperties: false, required, properties: props });
const arr = (items) => ({ type: "array", items });
const numOrNull = { type: ["number", "null"] };

/**
 * The model call returns ONLY assumptions + prose — never computed absolutes. `*_basis` explains the
 * reasoning; the script prefixes the mgmt-guidance/Est. tag deterministically. Gross-margin and
 * adj-EBITDA fields are nullable: null = "not stated / not a reported KPI", never a guess.
 */
export const MODEL_JSON_SCHEMA = strObj(
  {
    // E — revenue growth (%), guided where C.1 has it, else a directional estimate.
    revenue_growth_fy27: { type: "number" },
    revenue_growth_fy28: { type: "number" },
    revenue_growth_basis: { type: "string" },
    // E — EBITDA margin (%) and net margin (%).
    ebitda_margin_fy27: { type: "number" },
    ebitda_margin_fy28: { type: "number" },
    net_margin_fy27: { type: "number" },
    net_margin_fy28: { type: "number" },
    margin_basis: { type: "string" },
    // E — gross margin (%): estimate only if commentary supports it, else null (Screener omits it).
    gross_margin_fy27: numOrNull,
    gross_margin_fy28: numOrNull,
    // E — one-line driver per row.
    driver_revenue: { type: "string" },
    driver_gross_margin: { type: "string" },
    driver_ebitda: { type: "string" },
    driver_ebitda_margin: { type: "string" },
    driver_pat: { type: "string" },
    driver_net_margin: { type: "string" },
    // E — adjusted EBITDA margin: include the row ONLY if the company reports/emphasises it as a KPI.
    reports_adj_ebitda: { type: "boolean" },
    adj_ebitda_margin_fy26: numOrNull,
    adj_ebitda_margin_fy27: numOrNull,
    adj_ebitda_margin_fy28: numOrNull,
    driver_adj_ebitda: { type: "string" },
    // E — the model caveat (what breaks it).
    assumptions_note: { type: "string" },
    // G — re-rating triggers (synthesised from thesis + guidance) + the conviction verdict.
    rerating_triggers: arr({ type: "string" }),
    conviction: { type: "string", enum: ["Buy-watch", "Hold-watch", "Avoid-watch"] },
    conviction_note: { type: "string" },
  },
  [
    "revenue_growth_fy27", "revenue_growth_fy28", "revenue_growth_basis",
    "ebitda_margin_fy27", "ebitda_margin_fy28", "net_margin_fy27", "net_margin_fy28", "margin_basis",
    "gross_margin_fy27", "gross_margin_fy28",
    "driver_revenue", "driver_gross_margin", "driver_ebitda", "driver_ebitda_margin", "driver_pat", "driver_net_margin",
    "reports_adj_ebitda", "adj_ebitda_margin_fy26", "adj_ebitda_margin_fy27", "adj_ebitda_margin_fy28", "driver_adj_ebitda",
    "assumptions_note", "rerating_triggers", "conviction", "conviction_note",
  ]
);

/** The final synthesis: 5–7 decision-relevant bullets across B–G (count enforced at assembly). */
export const TAKEAWAYS_JSON_SCHEMA = strObj(
  { key_takeaways: arr({ type: "string" }) },
  ["key_takeaways"]
);
