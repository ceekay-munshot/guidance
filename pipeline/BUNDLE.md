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
  bundle.json      the structured data (below)         ← Step 6 writes
  transcript.txt   extracted concall transcript text (if a transcript was found + fetched)
  ppt.txt          extracted investor-PPT text (if found + fetched)
  report.json      the report (schema-shaped, built up slice-by-slice)  ← Step 7+ write
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
    "risks":                     [],     // Step 8 — C.6  (web-sourced — Step 7 leaves it [])
    "management_tone":           [ … ],  // Step 7 — C.7
    "analyst_tone":              { … }    // Step 7 — C.8
  },
  "thesis":         [],   // Step 8 — Section D  (falsifiable bull points)
  "anti_thesis":    [],   // Step 8 — Section D  (falsifiable bear points)
  "key_takeaways":  [],   // Step 8 — synthesis
  "financials":     { … },// Step 9 — from bundle.fy26a + the model
  "valuation":      { … },// Step 9
  "next_steps":     [ … ] // Step 9
}
```

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
