# Munshot — Concall Deep Dive

A per-company **Concall Deep Dive** dashboard for **MGA**. Search for any Indian listed
company, click **Run Analyze**, and get an analyst-grade research report on its latest quarterly
earnings call: business overview, concall breakdown, thesis vs anti-thesis, an editable financial
model, live valuation, and a Buy/Hold/Avoid-watch verdict — then export it as a branded **PDF** or
**Excel** workbook. **One run = one company.**

Static site, no build step. Vanilla JS ES modules; Tailwind, fonts and Lucide via CDN; jsPDF +
jspdf-autotable and ExcelJS loaded on demand (from unpkg) only when you export. Served by a
Cloudflare Worker that also owns the `/api/*` routes.

> **Build status: COMPLETE (Step 12 of 12).** Three-screen product · live on-demand pipeline ·
> saved-runs library · polished report · branded PDF/Excel exports. See _What's done_ below.

## The product — three screens

1. **Landing** — a premium hero (“Concall Deep Dive — MGA”), a search box wired to the Muns
   stock-search API (India-listed companies only), and a **saved-runs library** of past analyses
   (newest first; click a card to reopen the cached report instantly, or **Re-run** to refresh).
2. **Loading** — an honest, staged progress bar in plain language (Gathering financials → Pulling
   the call → Reading commentary → Researching → Fact-checking → Modelling → Assembling). Runs are
   server-side and **survive tab-switch / reload** — the page re-attaches and catches up, or jumps
   straight to the finished report. A run that can't be resolved surfaces a clean, themed error.
3. **Report** — institutional presentation: sticky scroll-spy section nav, right-aligned tabular
   numbers, an **editable** financial model + live valuation, and the verdict. Header actions:
   **Export PDF**, **Export Excel**, **Regenerate**, and back-to-library.

The client language never exposes internals (no “GitHub Actions” / “KV” / “workflow”).

## Exports (Step 12)

Both exports run **entirely in the browser** from the report currently open — no backend, no report
schema change. Libraries load on demand from **unpkg** (this network blocks jsdelivr); if a lib
fails, the export degrades gracefully.

- **Export PDF** — jsPDF + jspdf-autotable build a *packed, selectable* institutional note
  (not a screenshot): compact masthead with a brand-gradient rule + “Prepared for MGA” + a
  colour-coded conviction snapshot, then sections **A→G** as dense tables (brand-filled headers,
  zebra tint rows, right-aligned numbers, colour-coded stance/flag/tone/source), a slim
  “Munshot × MGA · Confidential · page X/Y · disclaimer” footer on every page, and a “Thank you —
  Munshot × MGA” closing card. Non-Latin-1 glyphs (₹, Δ, arrows) are sanitised so the core PDF
  fonts never render tofu. If jsPDF can’t load, the button surfaces a clean error (no silent fail).
- **Export Excel** — ExcelJS builds a colour-graded, five-sheet workbook
  (**Summary · Concall · Thesis & Risks · Financials · Valuation**). Every sheet has a merged brand
  header band + sub-band (frozen), thin borders, alternating tints, brand-coloured section rows, and
  a disclaimer footer. Numbers are stored **raw** with proper formats — Rs-Cr `#,##0`, percentages
  as `0.0"%"` (stored as whole numbers, so no accidental ×100), multiples `0.0"x"` — and
  right-aligned. Conviction / stance / trigger cells are colour-filled. **CSV fallback** if ExcelJS
  won’t load.
- **Filenames:** `Munshot-ConcallDeepDive-<TICKER>-<QUARTER>.pdf` / `.xlsx`.

The pure builders live in `public/js/export.js` and are unit-tested offline (`worker/test/export.test.mjs`)
against the sample report, a PPT-only report, and a bare `{}` report — so a report missing any field
never throws.

## Architecture

```
  Browser (public/, vanilla ES modules, CDN libs)
     │  GET  /api/search?q=…       → Muns stock search (India-only), server-side token
     │  GET  /api/reports          → saved-runs library (per-slug cards)
     │  POST /api/analyze          → trigger a run
     │  GET  /api/report?slug=…    → status while running, finished report JSON on done
     │  GET  /api/universe         → local fallback company list (if Muns search is down)
     │  (Export PDF/Excel run fully client-side from the loaded report — no API)
     ▼
  Cloudflare Worker (worker/index.js)
     ├─ serves ./public via the ASSETS binding
     ├─ /api/search  →  proxies Muns (Bearer MUNS_TOKEN), filters country === "India"
     ├─ /api/reports →  REPORTS.list("report-meta:*") + reads each card, newest first
     ├─ /api/report  →  reads KV; freshness cache; in-flight de-dup; done-gate vs KV lag
     └─ /api/analyze →  server-derives the slug, then workflow_dispatch (GITHUB_TOKEN)
     │
     │  POST workflow_dispatch (fetch-company.yml) {company, ticker, slug}
     ▼
  GitHub Action (.github/workflows/fetch-company.yml)  ──runs──▶  pipeline/ (Node ESM)
     │  status:<slug>=running → fetch transcript/PPT + inputs → extract → research → verify
     │  → model → finalize → validate vs report.schema.json
     │  writes progress per stage; on success PUTs report + done; on failure PUTs error
     │  (CF_ACCOUNT_ID + CF_KV_NAMESPACE_ID + CF_API_TOKEN)
     ▼
  Cloudflare KV (namespace REPORTS)
     │  report:<slug>       the report JSON          status:<slug>   {state,stage,generated_at,…}
     │  report-meta:<slug>  one library card per run
     ▲
     └── Worker reads on GET /api/report + /api/reports   (the Worker never writes KV)
```

The Worker is the **only** thing the browser talks to; the Action is the **only** thing that writes
KV; the **report schema is the single contract** (`public/data/report.schema.json`) every step keys
off. KV is the source of truth — reports are not committed back to the repo. A report is served from
cache while newer than `FRESH_DAYS` (14); the report’s **Regenerate** button re-runs past the cache.

### Source traceability

Every sourced fact is traceable to where it came from. Facts carry a `source`
(`Transcript | PPT | Web | Est.`) plus, where available, a **verbatim `quote`** and a
`source_url`:

- The extract step asks the model for the **exact backing sentence** per transcript fact, and
  `verifyQuotes` (in `extract-assemble.mjs`) **drops any quote that isn't literally found in the
  transcript** — so every quote we publish is a *checked* invariant, guaranteed Ctrl+F-able.
- Web risks keep their citation URL (parsed from the model's `(Source: <URL>)`).
- In the report, each source chip is a **link**: an HTML page opens with a Chromium scroll-to-text
  fragment (`#:~:text=…`) that highlights the sentence; a transcript/deck PDF opens and a ⌕ button
  copies the exact quote so the reader Ctrl+Fs it (browsers can't deep-link inside a PDF). A
  **Sources** panel lists every document + web source. Both exports carry it — the Excel gains a
  **Sources** sheet (a provenance ledger with clickable URLs + quotes) and the PDF a **Sources**
  page. Helpers live in `public/js/provenance.js` (unit-tested).

### Best-effort partial reports

A single unavailable/odd field never discards a whole analysis. At the finalize gate, if the complete
report isn’t schema-valid, `pipeline/lib/salvage.mjs` blanks/drops **only best-effort fields**
(a segment with an undisclosed margin, an “n.m.” multiple for a loss-making company, a malformed
concall item, an empty section) and publishes the rest, flagged **partial** — the report screen shows
a small “some data was unavailable” note and renders the gaps as “—”/“n.m.”. It still **hard-fails**
when something *load-bearing* is broken (company identity, price inputs, the financial model, the
verdict, the takeaways) — because a confidently-wrong number in an investment note is worse than a
visible gap. Every degraded field is logged in the Action and never silently faked.

Canonical slug = `slugify(ticker)` (server-derived) so one stock maps to exactly one KV key,
regardless of how its name is typed — and a client can never poison another company’s cache.

## Repo layout

```
wrangler.jsonc                     Worker + static-assets config (ASSETS binding, REPORTS KV, vars)
worker/index.js                    Worker: /api/* routes (search/reports/analyze/report) + assets
worker/test/                       offline suites: worker.test.mjs, analyze.test.mjs, export.test.mjs
public/
  index.html                       three-screen shell + brand styles (MGA)
  js/app.js                        router · landing/search/library · loading/poll/resume · report mount
  js/report.js                     report renderer + editable model/valuation (pure recompute)
  js/analyze.js                    pure Analyze helpers (slug, stages, sort, relative-time, resume)
  js/export.js                     STEP 12 — client-side PDF + Excel builders (+ CSV fallback)
  js/ui.js                         DOM/format helpers (escapeHtml, debounce, …)
  data/
    report.schema.json             THE CONTRACT — report shape every step keys off
    sample-report.json             filled, internally-consistent example (Navin Fluorine, Q4FY26)
    universe.json                  local fallback company list for the search box
.github/workflows/fetch-company.yml  the compute pipeline (dispatched by the Worker) + offline tests
pipeline/                          Node ESM pipeline (fetch → extract → research → verify → model)
  kv-put.mjs                       publishes report / progress / error + per-slug library card to KV
  lib/kv.mjs                       CF KV REST helpers (the Action’s only KV writer)
```

## Local development

No install for the frontend — it’s CDN-only. To run the Worker + static assets locally:

```sh
npx wrangler dev
```

Run the offline test suites (pure JS, no deps, no network):

```sh
node pipeline/test/extract.test.mjs
node pipeline/test/research.test.mjs
node pipeline/test/model.test.mjs
node worker/test/worker.test.mjs
node worker/test/analyze.test.mjs
node worker/test/export.test.mjs
```

## Secrets & bindings the owner must add

### Cloudflare Worker

| Where | Name | Purpose |
| --- | --- | --- |
| `wrangler.jsonc` (binding) | `ASSETS` | serves `./public` |
| `wrangler.jsonc` (binding) | `REPORTS` (KV namespace `id`) | the report / status / library store (not secret) |
| `wrangler.jsonc` (vars) | `GITHUB_REPO`, `GITHUB_BRANCH` | which repo/branch to dispatch |
| `wrangler secret put` | **`GITHUB_TOKEN`** | fine-grained PAT, this repo, **Actions: Read & write** — dispatches the workflow (never exposed to the client) |
| `wrangler secret put` | **`MUNS_TOKEN`** | bearer for the Muns stock-search API, used server-side by `/api/search`. Without it, search falls back to `public/data/universe.json` |

### GitHub Action — repo secrets (Settings → Secrets and variables → Actions)

| Name | Purpose |
| --- | --- |
| `OPENAI_API_KEY` (+ optional `ANTHROPIC_API_KEY`) | analysis LLM calls (structured outputs; cross-provider verify) |
| `SCREENER_EMAIL`, `SCREENER_PASSWORD` | Screener login (price / financials / peer table) |
| `FIRECRAWL_API_KEY`, `SCRAPEDO_API_KEY` | fetch transcripts / decks / web pages |
| `CF_ACCOUNT_ID` | Cloudflare account id |
| `CF_API_TOKEN` | token scoped to **Workers KV Storage: Edit** — the Action writes KV |
| `CF_KV_NAMESPACE_ID` | the `REPORTS` KV Namespace ID (same value as in `wrangler.jsonc`) |

Nothing writes secrets into the repo, into KV, or into any exported file.

## How MGA uses it

1. Open the dashboard, **search** a stock (e.g. type `RELIAN`) → India-listed matches only.
2. **Run Analyze** → watch the staged progress (you can switch tabs / reload; it resumes).
3. Read the **report** — scroll-spy nav, institutional tables, editable model + live valuation, verdict.
4. **Export PDF** (a packed research note) or **Export Excel** (a colour-graded workbook) to share.
5. Back on Landing, the run is saved in the **library** — reopen instantly, or **Re-run** to refresh.

## Deployment

Cloudflare Workers, deployed on push to `main` (Cloudflare Git integration). The static site ships
from `./public` via the `ASSETS` binding; `worker/index.js` owns `/api/*`.

## What's done (Step 12 — final)

- ✅ Three-screen product (Landing search + library · Loading resume-proof · Report).
- ✅ Live, on-demand pipeline: browser → Worker → GitHub Action → KV, one company per run.
- ✅ Saved-runs library (per-slug cards, newest first, instant cached open + re-run).
- ✅ Polished institutional report (editable model, live valuation, scroll-spy, verdict).
- ✅ Branded client-side **PDF + Excel** exports (CSV fallback), all offline-tested.

### Future enhancements (not built)

- **Abuse guardrail:** `/api/analyze` is open; each run costs LLM + compute. Add a light passcode or
  per-IP rate-limit in `handleAnalyze` (the single choke point) — mirror the sibling repo’s
  `ADD_FUND_PASSCODE` pattern.
- Optional: a landscape / side-by-side thesis layout in the PDF, and a charts sheet in the workbook.

## Notes

- Reports are research **observations, not investment advice** — Munshot is not a SEBI-registered
  adviser. The exports carry the same disclaimer.
- The frontend stays build-tooling-free (CDN only). Pipeline Node deps are no-save installs in CI.

---

_Munshot · Concall Deep Dive — for MGA._
