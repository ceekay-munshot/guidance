# Schema-validation TODO — deferred strictness gate

A running checklist of schema-strictness tightenings we've **deliberately deferred**.
We apply them as **one validation gate** when the LLM pipeline is built (~step 8), where
they validate **real generated output** — not the hand-authored `sample-report.json`, which
already satisfies all of them. Adding them now would only harden a fixture we control; the
value is in rejecting bad *pipeline* output.

> Rule: when a review flags "the schema allows nonsensical value X", add it here instead of
> patching the contract mid-build. The contract stays stable for the renderer/model steps.

## Already applied (in the contract now — for context)
These four are in `public/data/report.schema.json` because they protect the valuation
contract every step keys off:
- `meta.inputs` — nested `required` on cmp, cmp_date, shares_out_cr, market_cap_cr, net_debt_cr.
- `financials.rows` — `minItems` + per-key `contains` for the six mandatory keys + `uniqueItems`.
- `meta.sources` — nested `required` on transcript_url, ppt_url, concall_date (values may be null).
- `financials.rows[]` — stable `key` + `unit` (Task A).

## Deferred — apply at the step-8 validation gate
Each item: what's currently under-constrained, and the intended fix.

- [ ] **L52 — positive valuation denominators.** `cmp`, `shares_out_cr`, `market_cap_cr` are
  plain numbers; `0`/negative would pass. Add `exclusiveMinimum: 0` to these three. Keep
  `net_debt_cr` unconstrained (net cash → negative is legitimate).
- [ ] **L86 — bound `about.revenue_mix[].pct`.** Add `minimum: 0`, `maximum: 100`. (Consider
  also asserting the segments sum to ~100 in pipeline code, not the schema.)
- [ ] **L123 — hard guidance must carry a value.** When `concall.guidance[].type == "hard"`,
  `value` must be non-null. Express with `if/then` (directional may stay null).
- [ ] **L290 — non-null forecasts for valuation rows.** For rows with key `revenue`, `ebitda`,
  `pat`, require `fy27e`/`fy28e` to be numbers (the valuation recompute divides by them).
  Express with per-key `if/then`. Keep nullability for rows the math doesn't consume.

## Intentionally NOT planned
- [x] ~~**L267 — make `financials.rows` an object keyed by `key` (true per-key uniqueness)**~~ —
  **Won't do.** The array-of-rows-with-`key`+`unit` shape is the right contract: it preserves
  display order for the renderer and is directly editable in the step-5 model (row list with
  stable ids). `uniqueItems` already blocks exact-duplicate rows; the pipeline will assert
  one-row-per-key in code. Reshaping to an object would complicate both the renderer and the
  editable model for no real gain. This is a deliberate decision, not an oversight.
