# Raw data bundle — `pipeline/out/<slug>/`

Step 6 (`fetch-company.mjs`) writes a **raw** bundle — real fetched numbers + extracted
document text, with provenance on every field. **No LLM, no report** yet (that's Step 7).
Output is **git-ignored** (`pipeline/out/`).

## Run it

```sh
# deps are NOT committed — no-save install (same convention as the sibling repo)
npm install --no-save playwright pdfjs-dist cheerio
npx playwright install --with-deps chromium

# standalone
SCREENER_EMAIL=… SCREENER_PASSWORD=… FIRECRAWL_API_KEY=… SCRAPEDO_API_KEY=… \
  node pipeline/fetch-company.mjs "Navin Fluorine"
```

…or click **Actions → fetch-company → Run workflow** (needs the four secrets set), then
download the `bundle` artifact.

## Files

```
pipeline/out/<slug>/
  bundle.json        the structured data (below)         ← Step 6 writes
  transcript.txt     extracted concall transcript text (if a transcript was found + fetched)
  ppt.txt            extracted investor-PPT text (if found + fetched)
  report.json        the report (schema-shaped, built up slice-by-slice)  ← Step 7+ write
  verification.json  Step 8 audit sidecar (verdicts on Step 7's transcript claims — NOT part of the report)
```

## `bundle.json` shape

Every number maps 1:1 onto `public/data/report.schema.json`:

```jsonc
{
  "ok": true,                    // structural self-check passed
  "query": "Navin Fluorine",
  "fetched_at": "2026-…Z",
  "meta": {
    "company", "ticker", "slug", "sector", "sub_sector", "screener_url",
    "quarter": "Q4FY26",         // from concall title, else inferred from its date
    "quarter_confirmed": true,   // false when the latest posted concall ≠ the expected quarter
    "expected_quarter": "Q4FY26",
    "transcript_available": true // false = PPT-only / no transcript posted
  },
  "inputs": {                    // → report.schema meta.inputs
    "cmp", "cmp_date",           // cmp_date = fetch date (live price)
    "shares_out_cr",             // derived: market_cap_cr / cmp
    "market_cap_cr", "net_debt_cr"
  },
  "fy26a": {                     // → financials.rows[*].fy26a (year ending Mar-2026)
    "revenue", "ebitda", "ebitda_margin_pct",
    "pat", "net_margin_pct",
    "gross_margin_pct"           // null when Screener doesn't report it (never fabricated)
  },
  "sources": {                   // → report.schema meta.sources
    "transcript_url", "ppt_url", "concall_date"
  },
  "provenance": { "<field>": { "source": "<url>", "fetched_at": "…", "note": "…" } },
  "documents": { "transcript": { "url", "chars", "via", "file" }, "ppt": { … } },
  "diagnostics": { "notes": [ … ], "attempts": { "transcript": [ … ] } },
  "self_check": { "ok": true, "critical": [], "problems": [ … ] }
}
```

## `report.json` — each step fills its slice

`report.json` is the single per-company output that the frontend eventually consumes. It is
**not** written all at once: each pipeline step reads the file if it exists, fills in the slice
it owns, and writes it back. The shape is `public/data/report.schema.json` (the contract);
`public/data/sample-report.json` is the frontend's fixture and stays as-is.

```jsonc
{
  "meta":        { … },   // Step 7 — passthrough from bundle (company/ticker/quarter/inputs/sources)
  "about":       { … },   // Step 7 — Section B (sector from bundle; products…margins from transcript→PPT)
  "concall": {
    "guidance":                  [ … ],  // Step 7 — C.1  (source-tagged: Transcript, or PPT if PPT-only)
    "themes":                    [ … ],  // Step 7 — C.2
    "tone_shift_vs_last_quarter": "…",   // Step 7 — C.2  ("unknown" if no prior call)
    "expansion_flags":           [ … ],  // Step 7 — C.3
    "thesis_triggers":           [ … ],  // Step 7 — C.4
    "classification":            [ … ],  // Step 7 — C.5
    "risks":                     [ … ],  // Step 8a — C.6  (WEB-sourced; Step 7 leaves it [])
    "management_tone":           [ … ],  // Step 7 — C.7
    "analyst_tone":              { … }    // Step 7 — C.8
  },
  "thesis":         [ … ],// Step 8a — Section D  (falsifiable bull points, Web/Est.)
  "anti_thesis":    [ … ],// Step 8a — Section D  (falsifiable bear points, Web/Est.)
  "key_takeaways":  [],   // Step 9 — synthesis across B–G (needs F + G, so it waits)
  "financials":     { … },// Step 9 — from bundle.fy26a + the model
  "valuation":      { … },// Step 9
  "next_steps":     [ … ] // Step 9
}
```

A second model (Step 8b) then AUDITS Step 7's transcript claims and may prune a clear
hallucination out of `concall.guidance` / `concall.expansion_flags` / `about.*`; every verdict is
logged to the `verification.json` sidecar (never surfaced in the client report).

**Step 7** (`extract-concall.mjs`, the first LLM step) writes `meta` + `about` (B) +
`concall.{guidance,themes,tone_shift_vs_last_quarter,expansion_flags,thesis_triggers,`
`classification,management_tone,analyst_tone}` (C.1–C.5, C.7, C.8). It leaves
`concall.risks` as `[]` (Step 8 web-sources it) and leaves `thesis` / `anti_thesis` /
`key_takeaways` / `financials` / `valuation` / `next_steps` for Steps 8–9. It reads
`{bundle.json, transcript.txt, ppt.txt}`, so it must run **after** Step 6.

```sh
# after fetch-company has produced pipeline/out/<slug>/ :
OPENAI_API_KEY=…  [OPENAI_MODEL=…]  node pipeline/extract-concall.mjs "Navin Fluorine"
```

Extraction rules honoured by Step 7:

- **Section B** — `sector`/`sub_sector` come from the bundle (not re-derived). `products`,
  `segments`, `revenue_mix`, `margin_by_segment` come from the **transcript first, then PPT**.
  Where a segment margin isn't disclosed the value is the verbatim string **`"not disclosed"`**
  — never invented. (See `VALIDATION-TODO.md` for how this coexists with the numeric schema.)
- **Section C** — **transcript only** (PPT is not blended in); every C item is tagged
  `source: "Transcript"`. If no transcript was posted (`transcript_available:false` or a stub),
  Step 7 runs a reduced-confidence **PPT-only** pass and tags those items `source: "PPT"`.
- Model is one swappable constant (`OPENAI_MODEL` env → default in `lib/openai.mjs`), structured
  outputs (`response_format: json_schema`, `strict`), temperature `0.1`, token+cost logged.
- The written B+C is validated against `report.schema.json` before the process exits non-zero on
  failure. Offline unit tests (`pipeline/test/extract.test.mjs`, no deps, no OpenAI) cover
  prompt-building, assembly, source-tagging, the PPT-only path, and validation.

**Step 8a** (`research-concall.mjs`) adds the **web-grounded** slices Step 7 deliberately skipped:

```sh
# after extract-concall has written report.json:
OPENAI_API_KEY=…  [FIRECRAWL_API_KEY=…]  node pipeline/research-concall.mjs "Navin Fluorine"
```

- **C.6 risks** — a handful of TARGETED web queries (OpenAI Responses `web_search` → Firecrawl
  `/v1/search` fallback) surface risks **not** volunteered on the call: pending litigation,
  SEBI/regulatory overhang, promoter pledge/stake changes, related-party flags, rating actions.
  Each `risk` string ends with a real `(Source: <URL>)`; `source` is `"Web"`. **Empty array if
  nothing is found — never a fabricated risk.**
- **Section D thesis / anti-thesis** — 3–5 structural points each, every one carrying a concrete
  **`falsifier`** (a metric/event that would prove it wrong). A point with no genuine falsifier is
  **dropped** at assembly (the schema can't express "non-empty", so the pipeline enforces it).
  `source` is `"Web"` or `"Est."` per point.

**Step 8b** (`verify-extract.mjs`) is an **internal quality tool** — it adds no visible section to
the report:

```sh
# a second model audits Step 7's transcript claims:
OPENAI_API_KEY=…  [ANTHROPIC_API_KEY=…]  node pipeline/verify-extract.mjs "Navin Fluorine"
```

- Re-reads `report.json` + `transcript.txt` and asks a **second model** to judge Step 7's
  transcript-sourced claims (C.1 guidance, C.3 expansion_flags, B's transcript-derived facts)
  against the transcript, returning `supported` / `partial` / `unsupported` + confidence per claim.
- Conservatively **drops only** claims marked `unsupported` with non-low confidence (clear
  hallucinations); everything else is kept. **All** verdicts are logged to `verification.json`.
- `VERIFY_MODEL` is one configurable constant (defaults to a *different* OpenAI model than
  extraction). Setting **`ANTHROPIC_API_KEY`** makes the audit a true **cross-provider** check (a
  different model family judging the first model) — stronger and more independent than same-provider.
  Gemini could be added the same way.
- Offline unit tests (`pipeline/test/research.test.mjs`, no deps, no network) cover risk/thesis
  assembly, the falsifier rule, and the verifier flagging logic (a planted hallucinated guidance
  item is asserted flagged, dropped, and logged).

## What "graceful degradation" means here

- A missing credential, blocked page, or absent field is **reported** (console + `diagnostics`
  + `self_check.problems`), never fabricated. The script never crashes.
- Fetch fallback chain per document: **direct** (BSE/NSE, per-host `Referer` + an NSE cookie
  warm-up) → **Firecrawl** → **Scrape.do**. Each hop that fails is recorded in
  `diagnostics.attempts`.
- Real fetched numbers **will differ** from `public/data/sample-report.json` — that sample is
  the frontend's fixture and stays as-is.

## Fields Screener can't give (expected nulls / notes)

- `gross_margin_pct` — not on Screener's P&L → `null`.
- `net_debt_cr` — Screener's condensed balance sheet shows **Borrowings** but usually no cash
  line; when cash is absent, net debt is approximated as **gross borrowings** with a note.
- `cmp_date` — Screener doesn't expose the exact price timestamp → the **fetch date** (the CMP
  is the live price at run time).
