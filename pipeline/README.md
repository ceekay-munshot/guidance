# pipeline/ — compute engine (placeholder)

> **Status: not built yet (step 1).** This directory is a documented placeholder.
> The real Node pipeline lands in later steps (~step 8–11). Nothing here runs today.

## What this will be

A Node script, run by `.github/workflows/analyze.yml` on `workflow_dispatch`, that
turns one company into one finished report and writes it to Cloudflare KV. It is the
only thing that ever **writes** KV; the Worker only reads.

```
workflow_dispatch({ slug, company, ticker })
        │
        ▼
  pipeline/ (Node)
    1. resolve      → confirm company, latest reported quarter
    2. fetch        → concall transcript + investor PPT (Firecrawl / web),
                      price & size inputs (CMP, shares out, net debt)
    3. analyze      → LLM calls produce each section of the report
    4. validate     → assert output matches public/data/report.schema.json
    5. publish      → PUT report JSON to Cloudflare KV (REPORTS) keyed by slug
```

## The contract

The pipeline's **only** output contract is
[`../public/data/report.schema.json`](../public/data/report.schema.json). Every field it
emits must validate against that schema, and every fact must carry a `source` of
`"Transcript" | "PPT" | "Web" | "Est."`. See
[`../public/data/sample-report.json`](../public/data/sample-report.json) for a filled,
internally-consistent example (valuation multiples reconcile to `meta.inputs` + `financials`).

## Secrets it will need (GitHub repo secrets)

| Secret | Purpose |
| --- | --- |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | LLM providers for the analysis |
| `FIRECRAWL_API_KEY` | fetch transcripts / investor decks / web |
| `CF_ACCOUNT_ID` | Cloudflare account id |
| `CF_API_TOKEN` | token scoped to **Workers KV Storage: Edit** |
| `CF_KV_NAMESPACE_ID` | the `REPORTS` KV namespace id |

## Dependencies

Node deps arrive with the pipeline (no-save installs, per the repo's no-build-tooling
rule for the frontend). Nothing to install for step 1.
