# Munshot — Concall Deep Dive

A per-company **Concall Deep Dive** dashboard. Search for one Indian listed company,
click **Run Analyze**, and get an analyst-grade research report on its latest quarterly
earnings call: business overview, concall breakdown, thesis vs anti-thesis, an editable
financial model, valuation, and a Buy/Hold/Avoid-watch verdict. **One run = one company.**

Static site, no build step. Vanilla JS ES modules; Tailwind, fonts, Lucide, ECharts and
ExcelJS all via CDN. Served by a Cloudflare Worker that also owns the `/api/*` routes.

> **Build status:** Step 2 of ~12 — themed shell + report **contract**
> (`public/data/report.schema.json`) + a production type-ahead search + a real
> request→poll run-state machine against a fixture-backed Worker that simulates the
> job lifecycle (queued → done). The report renderer, real compute pipeline, KV, and
> GitHub dispatch come in later steps.

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

Then open the printed localhost URL. `/api/universe` serves the local fixture.
`POST /api/analyze` queues an in-memory job (`status:"queued"`, or `"done"` if already
run); `GET /api/report?slug=…` returns 404 (`{status:"queued"}`) until a short simulated
delay elapses, then 200 with the sample report — so the real request→poll loop runs
end-to-end today. (The in-memory store is a stand-in for the `REPORTS` KV until step 10.)

## How a live analysis flows (Step 10)

```
client picks a company → POST /api/analyze
      → Worker: fresh report in KV?  → yes: return done (client GETs it)
                job already running?  → yes: return its status (no duplicate)
                else: status:<slug>=queued + workflow_dispatch(fetch-company.yml, {company, slug})
      → Action: status:<slug>=running → fetch→extract→research→verify→model→finalize
                → on success: report:<slug>=report.json + status:<slug>=done
                → on failure: status:<slug>=error
      → client polls GET /api/report?slug=… → renders the report on done
```

KV is the source of truth (reports are **not** committed back to the repo). A report is served
from cache while newer than `FRESH_DAYS` (14); the report card has a **Regenerate** button that
re-runs past the cache.

## Deployment

Cloudflare Workers, deployed on push to `main` (Git integration). The static site ships from
`./public` via the `ASSETS` binding; `worker/index.js` owns `/api/*`.

## Secrets & bindings the owner must add (GO LIVE)

### Cloudflare Worker

- **Binding + vars — already in `wrangler.jsonc`:** `ASSETS`; the `REPORTS` KV namespace
  (`id` = your Namespace ID, not secret); vars `GITHUB_REPO` / `GITHUB_BRANCH`.
- **Secret — `wrangler secret put GITHUB_TOKEN`** (never committed): a fine-grained PAT scoped to
  this repo with **Actions: Read & write**. The Worker uses it only to dispatch the workflow.

### GitHub Action — repo secrets (Settings → Secrets → Actions)

| Name | Purpose |
| --- | --- |
| `OPENAI_API_KEY` (+ optional `ANTHROPIC_API_KEY`) | analysis LLM calls |
| `SCREENER_EMAIL`, `SCREENER_PASSWORD` | Screener login |
| `FIRECRAWL_API_KEY`, `SCRAPEDO_API_KEY` | fetch transcripts / decks / web |
| `CF_ACCOUNT_ID` | Cloudflare account id |
| `CF_API_TOKEN` | token scoped to **Workers KV Storage: Edit** — the Action writes KV |
| `CF_KV_NAMESPACE_ID` | the `REPORTS` KV Namespace ID (same value as in `wrangler.jsonc`) |

## GO-LIVE test checklist

1. **Push `main`** → the Worker deploys (Cloudflare Git integration).
2. **Set the values above:** the 3 Cloudflare Action secrets, the Worker `GITHUB_TOKEN`, and the
   KV Namespace ID in `wrangler.jsonc` (already set to the owner's namespace).
3. **Open the site**, pick a company (or type any name/ticker), hit **Analyze**.
4. Watch the run fire in the repo's **Actions** tab; the page shows *Analyzing… (Ns)* while it polls.
5. When the Action finishes (~1–2 min), the **real report renders** (editable model + live valuation).
   A company that can't be resolved on Screener surfaces a clean error with **Try again**.

### Cost / abuse guardrail (optional, not wired)

Each run costs LLM + compute. `/api/analyze` is currently open. To gate it later, add a light
passcode or per-IP rate-limit in `handleAnalyze` (mirror the sibling repo's `ADD_FUND_PASSCODE`
pattern) — the handler is the single choke point, so it's a clean hook.

## Notes

- Reports are research **observations, not investment advice** — Munshot is not a SEBI-registered
  adviser.
- The frontend stays build-tooling-free (CDN only). Pipeline Node deps are no-save installs in CI.

---

_Munshot · Concall Deep Dive._
