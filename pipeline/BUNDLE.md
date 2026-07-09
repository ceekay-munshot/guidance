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
  bundle.json      the structured data (below)
  transcript.txt   extracted concall transcript text (if a transcript was found + fetched)
  ppt.txt          extracted investor-PPT text (if found + fetched)
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
