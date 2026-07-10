#!/usr/bin/env node
// fetch-company.mjs — STEP 6: real data pipeline, part 1 (NO LLM).
//
// Given a company name or ticker, resolve it on Screener, pull the financial snapshot +
// FY26 actuals, find the latest concall transcript + investor PPT, fetch & extract their text,
// and write a raw data bundle whose numbers map cleanly onto report.schema.json's
// meta.inputs / meta.sources / financials.rows[fy26a]. Every value carries its provenance.
//
// Runs two ways:
//   node pipeline/fetch-company.mjs "Navin Fluorine"
//   via .github/workflows/fetch-company.yml (owner clicks Run workflow with the 4 secrets)
//
// Secrets (env): SCREENER_EMAIL, SCREENER_PASSWORD, FIRECRAWL_API_KEY, SCRAPEDO_API_KEY.
// Degrades gracefully on any missing cred/field — reports what failed and why; never fabricates.

import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { resolveCompany, parseCompanyPage } from "./lib/screener.mjs";
import { fetchDoc, UA } from "./lib/fetchers.mjs";
import { extractPdfText } from "./lib/pdf.mjs";
import { selfCheck } from "./lib/selfcheck.mjs";
import { kvPut, kvConfigured } from "./lib/kv.mjs";
import { log, slugify, round, quarterFromDate, quarterFromTitle, expectedQuarter } from "./lib/util.mjs";

/** Best-effort progress ping to KV (Step 11 loading screen). No-op without SLUG/creds; never throws. */
async function kvProgress(stage) {
  const slug = process.env.SLUG;
  if (!slug || !kvConfigured()) return;
  try { await kvPut(`status:${slug}`, JSON.stringify({ state: "running", stage, updated_at: new Date().toISOString() })); } catch { /* cosmetic */ }
}

const OUT_ROOT = new URL("./out/", import.meta.url).pathname;
const TRANSCRIPT_MIN_CHARS = 2000; // below this a "transcript" is almost certainly a fetch failure

async function main() {
  const query = (process.argv[2] || process.env.COMPANY || "Navin Fluorine").trim();
  const fetched_at = new Date().toISOString();
  const env = {
    email: process.env.SCREENER_EMAIL,
    password: process.env.SCREENER_PASSWORD,
    firecrawlKey: process.env.FIRECRAWL_API_KEY,
    scrapedoKey: process.env.SCRAPEDO_API_KEY,
  };

  log.step(`Munshot fetch-company — "${query}"  (${fetched_at})`);
  for (const [k, v] of Object.entries({ SCREENER_EMAIL: env.email, SCREENER_PASSWORD: env.password, FIRECRAWL_API_KEY: env.firecrawlKey, SCRAPEDO_API_KEY: env.scrapedoKey })) {
    log.info(`${k}: ${v ? "set" : "MISSING"}`);
  }

  const diagnostics = { notes: [], attempts: {} };
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  // context.request shares cookies with the browser context (login + NSE warm-up carry over).
  const getText = async (url, headers = {}) => {
    const res = await context.request.get(url, { headers: { "User-Agent": UA, ...headers }, timeout: 45000 });
    if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
    return res.text();
  };
  const directGet = async (url, headers = {}) => {
    const res = await context.request.get(url, { headers, timeout: 45000, maxRedirects: 5 });
    return Buffer.from(await res.body());
  };

  let bundle = null;
  try {
    // ── Screener login (best-effort; unlocks nothing critical but reduces rate-limiting) ──
    if (env.email && env.password) {
      try {
        await page.goto("https://www.screener.in/login/", { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.fill('input[name="username"]', env.email);
        await page.fill('input[name="password"]', env.password);
        await Promise.all([page.click('button[type="submit"]'), page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {})]);
        log.ok("Screener login submitted");
      } catch (e) {
        log.warn(`Screener login failed (continuing anonymously): ${e.message}`);
        diagnostics.notes.push(`screener login: ${e.message}`);
      }
    } else {
      log.warn("no Screener creds — continuing anonymously (public data only)");
    }

    // ── 1. Resolve ──
    log.step("1. Resolve company on Screener");
    const resolved = await resolveCompany(query, getText);
    if (!resolved.ok) throw new Error(`could not resolve "${query}": ${resolved.note}`);
    log.ok(`${resolved.name} (${resolved.ticker}) → ${resolved.screener_url}`);
    const slug = slugify(resolved.ticker || resolved.name);

    // ── 2–4. Load the company page and parse snapshot / FY26 / concalls ──
    log.step("2–4. Parse company page (snapshot, FY26 actuals, concalls)");
    let html = "";
    try {
      await page.goto(resolved.screener_url, { waitUntil: "domcontentloaded", timeout: 45000 });
      // Screener lazy-loads the peers comparison table when it scrolls into view — nudge THAT section
      // in (not just the page bottom) and wait for the peers table specifically (waiting for any
      // data-table resolves instantly on the P&L table and never actually waits). Best-effort.
      try {
        await page.evaluate(() => document.querySelector("#peers")?.scrollIntoView());
        await page.waitForSelector("#peers table tbody tr", { timeout: 10000 });
      } catch { diagnostics.notes.push("peers table not confirmed loaded (lazy/absent) — valuation context may be partial"); }
      html = await page.content();
    } catch (e) {
      diagnostics.notes.push(`company page load: ${e.message}`);
      log.warn(`page.goto failed (${e.message}); trying request fetch`);
      html = await getText(resolved.screener_url).catch(() => "");
    }
    const parsed = parseCompanyPage(html);
    diagnostics.notes.push(...parsed.notes);
    const inp = parsed.inputs;
    log.info(`CMP ₹${inp.cmp ?? "—"} · mktcap ₹${inp.market_cap_cr ?? "—"}cr · shares ${round(inp.shares_out_cr, 2) ?? "—"}cr · net debt ₹${round(inp.net_debt_cr, 0) ?? "—"}cr`);
    log.info(`FY26A: revenue ₹${parsed.fy26a.revenue ?? "—"}cr · EBITDA ₹${parsed.fy26a.ebitda ?? "—"}cr · PAT ₹${parsed.fy26a.pat ?? "—"}cr`);

    // ── quarter identification (never silently substitute an older quarter / annual report) ──
    const latest = parsed.concalls.entries[0] || null;
    const parsedQ = latest ? quarterFromTitle(latest.title) || quarterFromDate({ y: latest.y, m: latest.m }).quarter || null : null;
    const expQ = expectedQuarter(fetched_at);
    const quarter = parsedQ;
    const quarter_confirmed = !!parsedQ && parsedQ === expQ;
    if (latest) log.ok(`latest concall: ${latest.date || "?"} → ${parsedQ || "?"} (expected ${expQ}) · confirmed=${quarter_confirmed}`);
    if (parsedQ && expQ && parsedQ !== expQ) diagnostics.notes.push(`latest posted concall is ${parsedQ}, but ${expQ} was expected by now — the expected quarter may not be posted yet`);
    if (!latest) diagnostics.notes.push("no concall entry found — quarter unconfirmed");

    const transcript_available = !!latest?.transcript;
    if (latest && !latest.transcript && latest.ppt) diagnostics.notes.push("PPT-only: latest concall has a PPT but no transcript");

    // ── 5. Fetch + extract transcript / PPT text ──
    await kvProgress("transcript"); // loading screen: "Pulling the latest earnings call & deck…"
    log.step("5. Fetch + extract documents");
    let nseWarmed = false;
    const warmNse = async () => {
      if (nseWarmed) return;
      try { await page.goto("https://www.nseindia.com/", { waitUntil: "domcontentloaded", timeout: 20000 }); nseWarmed = true; log.info("NSE cookies warmed"); }
      catch (e) { diagnostics.notes.push(`NSE warm-up failed: ${e.message}`); }
    };

    async function grab(kind, url) {
      if (!url) return null;
      if (/nseindia\.com/i.test(url)) await warmNse();
      const res = await fetchDoc(url, { directGet, firecrawlKey: env.firecrawlKey, scrapedoKey: env.scrapedoKey });
      diagnostics.attempts[kind] = res.attempts;
      let text = res.text || null;
      if (!text && res.bytes) {
        try { text = await extractPdfText(res.bytes); }
        catch (e) { diagnostics.attempts[kind].push(`pdf extract: ${e.message}`); }
      }
      if (text) {
        const file = `${kind}.txt`;
        log.ok(`${kind}: ${text.length} chars via ${res.via}`);
        return { url, chars: text.length, via: res.via, file, text };
      }
      log.warn(`${kind}: no text — ${res.attempts.join(" | ")}`);
      return { url, chars: 0, via: null, file: null, text: null };
    }

    const transcript = await grab("transcript", latest?.transcript);
    const ppt = await grab("ppt", latest?.ppt);

    // ── 6. Assemble the bundle with provenance ──
    const src = resolved.screener_url;
    const prov = (source, note) => ({ source, fetched_at, ...(note ? { note } : {}) });
    bundle = {
      ok: false, // set by the self-check below
      query,
      fetched_at,
      meta: {
        company: parsed.name || resolved.name,
        ticker: resolved.ticker,
        slug,
        sector: parsed.sector,
        sub_sector: parsed.sub_sector,
        screener_url: src,
        quarter,
        quarter_confirmed,
        expected_quarter: expQ,
        transcript_available,
      },
      // → report.schema.json meta.inputs
      inputs: {
        cmp: inp.cmp,
        cmp_date: fetched_at.slice(0, 10),
        shares_out_cr: round(inp.shares_out_cr, 4),
        market_cap_cr: round(inp.market_cap_cr, 0),
        net_debt_cr: round(inp.net_debt_cr, 0),
      },
      // → financials.rows[*].fy26a
      fy26a: {
        revenue: round(parsed.fy26a.revenue, 0),
        ebitda: round(parsed.fy26a.ebitda, 0),
        ebitda_margin_pct: round(parsed.fy26a.ebitda_margin_pct, 1),
        pat: round(parsed.fy26a.pat, 0),
        net_margin_pct: round(parsed.fy26a.net_margin_pct, 1),
        gross_margin_pct: parsed.fy26a.gross_margin_pct, // null when Screener doesn't report it
      },
      // → report.schema.json meta.sources
      sources: {
        transcript_url: latest?.transcript || null,
        ppt_url: latest?.ppt || null,
        concall_date: latest?.date || null,
      },
      // Valuation context for Step 9's F sanity-check (current P/E + history/peer medians). Best-effort.
      valuation_context: parsed.valuation_context,
      provenance: {
        cmp: prov(src, "Screener top-ratio 'Current Price'; cmp_date = fetch date (live price)"),
        shares_out_cr: prov(src, "derived: market_cap_cr / cmp"),
        market_cap_cr: prov(src, "Screener top-ratio 'Market Cap'"),
        net_debt_cr: prov(src, inp.net_debt_note || "Screener balance sheet: borrowings − cash"),
        revenue: prov(src, "Screener P&L, Mar-2026 column (Sales)"),
        ebitda: prov(src, "Screener P&L, Mar-2026 column (Operating Profit)"),
        ebitda_margin_pct: prov(src, "Screener P&L (OPM %)"),
        pat: prov(src, "Screener P&L (Net Profit)"),
        net_margin_pct: prov(src, "derived: PAT / revenue"),
        gross_margin_pct: prov(src, "not reported by Screener — left null"),
        transcript_url: prov(src, "Screener Documents → Concalls (latest)"),
        ppt_url: prov(src, "Screener Documents → Concalls (latest)"),
      },
      documents: {
        transcript: transcript ? { url: transcript.url, chars: transcript.chars, via: transcript.via, file: transcript.file } : null,
        ppt: ppt ? { url: ppt.url, chars: ppt.chars, via: ppt.via, file: ppt.file } : null,
      },
      diagnostics,
    };

    // ── self-check (structural; the OWNER validates the numbers live) ──
    const check = selfCheck(bundle, transcript, TRANSCRIPT_MIN_CHARS);
    bundle.ok = check.ok;
    bundle.self_check = check;

    // ── write the bundle + extracted text ──
    const outDir = join(OUT_ROOT, slug);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "bundle.json"), JSON.stringify(bundle, null, 2));
    if (transcript?.text) await writeFile(join(outDir, "transcript.txt"), transcript.text);
    if (ppt?.text) await writeFile(join(outDir, "ppt.txt"), ppt.text);
    log.step(`Wrote pipeline/out/${slug}/  (bundle.json${transcript?.text ? " + transcript.txt" : ""}${ppt?.text ? " + ppt.txt" : ""})`);

    printSummary(bundle);
    process.exitCode = check.ok ? 0 : 1; // red in CI on failure; artifact still uploads (if: always())
  } catch (e) {
    log.err(`fatal: ${e.stack || e.message}`);
    // Still write whatever we know, so the artifact has an evidence trail.
    try {
      const outDir = join(OUT_ROOT, slugify(query));
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, "bundle.json"), JSON.stringify({ ok: false, query, fetched_at, error: e.message, diagnostics }, null, 2));
    } catch { /* ignore */ }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

function printSummary(b) {
  log.step("EVIDENCE SUMMARY");
  const rows = [
    ["company", `${b.meta.company} (${b.meta.ticker})`],
    ["quarter", `${b.meta.quarter || "?"}  confirmed=${b.meta.quarter_confirmed}  (expected ${b.meta.expected_quarter})`],
    ["CMP", `₹${b.inputs.cmp} (${b.inputs.cmp_date})`],
    ["market cap", `₹${b.inputs.market_cap_cr} cr`],
    ["shares out", `${b.inputs.shares_out_cr} cr`],
    ["net debt", `₹${b.inputs.net_debt_cr} cr`],
    ["FY26 revenue", `₹${b.fy26a.revenue} cr`],
    ["FY26 EBITDA", `₹${b.fy26a.ebitda} cr (OPM ${b.fy26a.ebitda_margin_pct}%)`],
    ["FY26 PAT", `₹${b.fy26a.pat} cr (NPM ${b.fy26a.net_margin_pct}%)`],
    ["concall date", b.sources.concall_date || "—"],
    ["transcript", b.documents.transcript ? `${b.documents.transcript.chars} chars via ${b.documents.transcript.via} — ${b.sources.transcript_url}` : (b.meta.transcript_available ? "FAILED to fetch" : "none (PPT-only/absent)")],
    ["ppt", b.documents.ppt ? `${b.documents.ppt.chars} chars via ${b.documents.ppt.via}` : "—"],
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(14)} ${v}`);
  console.log(`\n  self-check: ${b.ok ? "PASS ✓" : "FAIL ✗"}`);
  if (b.self_check?.problems?.length) b.self_check.problems.forEach((p) => console.log(`    - ${p}`));
  if (b.diagnostics.notes.length) { console.log("  notes:"); b.diagnostics.notes.forEach((n) => console.log(`    · ${n}`)); }
}

// Run only when invoked directly (so tests can import lib pieces without launching Playwright).
if (process.argv[1]) {
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
  } catch {
    /* not the entry module */
  }
}
