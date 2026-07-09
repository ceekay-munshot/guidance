# Munshot — Concall Deep Dive

A per-company **Concall Deep Dive** dashboard. Search for one Indian listed company,
click **Run Analyze**, and get an analyst-grade research report on its latest quarterly
earnings call: business overview, concall breakdown, thesis vs anti-thesis, an editable
financial model, valuation, and a Buy/Hold/Avoid-watch verdict. **One run = one company.**

Static site, no build step. Vanilla JS ES modules; Tailwind, fonts, Lucide, ECharts and
ExcelJS all via CDN. Served by a Cloudflare Worker that also owns the `/api/*` routes.

> **Build status:** Step 1 of ~12 — the themed shell + the report **contract**
> (`public/data/report.schema.json`) + stubbed API. The report renderer, the real
> compute pipeline, KV, and GitHub dispatch come in later steps.

## Architecture

```
  Browser (public/, vanilla ES modules, CDN libs)
     │  GET /api/universe        → company list
     │  POST /api/analyze        → trigger a run
     │  GET /api/report?slug=…   → finished report JSON
     ▼
  Cloudflare Worker (worker/index.js)
     ├─ serves ./public via the ASSETS binding
     ├─ /api/*  →  (step 1) local fixtures  ·  (step 10) KV read + Action dispatch
     │
     │  step 10: POST workflow_dispatch (GITHUB_TOKEN)
     ▼
  GitHub Action (.github/workflows/analyze.yml)  ──runs──▶  pipeline/ (Node, later steps)
     │  fetch transcript/PPT + inputs → LLMs → validate vs report.schema.json
     │  step 10: PUT report JSON  (CF_ACCOUNT_ID + CF_API_TOKEN)
     ▼
  Cloudflare KV (namespace REPORTS, keyed by slug)
     ▲
     └── Worker reads on GET /api/report?slug=…   (Worker never writes KV)
```

The Worker is the only thing the browser talks to. The Action is the only thing that
writes KV. The report **schema is the single contract** every step keys off.

## Repo layout

```
wrangler.jsonc                 Worker + static-assets config (name, ASSETS binding)
worker/index.js                Worker: /api/* routes (stubbed) + asset fallthrough
public/
  index.html                   themed landing shell (search + Run Analyze)
  js/app.js                    universe load, type-ahead, request→poll plumbing
  js/ui.js                     DOM/format helpers
  data/
    report.schema.json         THE CONTRACT — report shape every step keys off
    sample-report.json         filled, internally-consistent example (Navin Fluorine, Q4FY26)
    universe.json              ~30 NSE/BSE companies for the search box
.github/workflows/analyze.yml  compute pipeline (placeholder / no-op for now)
pipeline/README.md             what the Node pipeline will do (placeholder)
```

## Local development

No install for the frontend — it's CDN-only. To run the Worker + static assets locally:

```sh
npx wrangler dev
```

Then open the printed localhost URL. `/api/universe` and `/api/report` serve the local
fixtures; `POST /api/analyze` returns `{ ok:true, slug, status:"done" }` so the
request→poll loop works end-to-end today.

## Deployment

Cloudflare Workers. Deploy is `npx wrangler deploy` (wire a push-to-`main` deploy in
CI when ready). The static site ships from `./public` via the `ASSETS` binding.

## Secrets & bindings the owner must add

None are needed for step 1 (everything is stubbed). Before the real pipeline is wired
(~step 10), add:

### Cloudflare Worker — `wrangler secret put <NAME>` (never commit these)

| Name | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | fine-grained PAT with `actions:write` — Worker dispatches the analyze workflow |
| `GITHUB_REPO` | `owner/repo` hosting `.github/workflows/analyze.yml` |
| `GITHUB_BRANCH` | git ref to dispatch against (e.g. `main`) |

### Cloudflare Worker — binding in `wrangler.jsonc`

| Binding | Purpose |
| --- | --- |
| `ASSETS` | static-asset fetcher for `./public` (already wired) |
| `REPORTS` | KV namespace holding finished reports, keyed by slug (add in step 10) |

### GitHub Action — repo secrets (Settings → Secrets → Actions)

| Name | Purpose |
| --- | --- |
| `OPENAI_API_KEY` (+ other LLM keys, e.g. `ANTHROPIC_API_KEY`) | analysis LLM calls |
| `FIRECRAWL_API_KEY` | fetch transcripts / investor decks / web |
| `CF_ACCOUNT_ID` | Cloudflare account id |
| `CF_API_TOKEN` | token scoped to **Workers KV Storage: Edit** — Action writes KV |
| `CF_KV_NAMESPACE_ID` | the `REPORTS` KV namespace id |

## Notes

- Sample data is for building the UI — **not investment advice.**
- The frontend stays build-tooling-free (CDN only), matching the sibling repo. Node deps
  for the pipeline come later as no-save installs.

---

_Munshot · Concall Deep Dive._
