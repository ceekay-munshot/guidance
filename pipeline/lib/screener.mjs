// screener.mjs — resolve a company on Screener and parse its public company page.
// Parsing is intentionally defensive (Screener's DOM shifts): every extractor try/catches and
// returns null + a note rather than throwing, so a partial page still yields a partial bundle.

import * as cheerio from "cheerio";
import { parseNum, parseLooseDate } from "./util.mjs";

const BASE = "https://www.screener.in";

/**
 * Resolve a name/ticker to a Screener company. `get(url)` returns response text (Playwright
 * request ctx, so Screener cookies apply). Uses the public search API, falls back to a guess.
 */
export async function resolveCompany(query, get) {
  const url = `${BASE}/api/company/search/?q=${encodeURIComponent(query)}`;
  let hits = [];
  try {
    hits = JSON.parse(await get(url)) || [];
  } catch (e) {
    return { ok: false, note: `search API failed: ${e.message}`, query };
  }
  if (!Array.isArray(hits) || hits.length === 0) return { ok: false, note: "no search results", query };
  // Prefer an exact-ish name/ticker match, else the top hit.
  const q = query.toLowerCase();
  const best = hits.find((h) => (h.name || "").toLowerCase() === q || (h.url || "").toLowerCase().includes(`/${q}/`)) || hits[0];
  const path = best.url || "";
  const ticker = (path.match(/\/company\/([^/]+)\//) || [])[1] || null;
  return { ok: true, name: best.name || query, ticker, path, screener_url: `${BASE}${path}`, candidates: hits.slice(0, 5).map((h) => h.name) };
}

// ── generic data-table reader ────────────────────────────────────────────────
function readTable($, sectionId) {
  const $t = $(`#${sectionId} table.data-table`).first();
  if (!$t.length) return null;
  const headers = [];
  $t.find("thead th").each((_, th) => headers.push($(th).text().trim()));
  const rows = new Map(); // normalised label → array of cell texts (aligned to headers)
  $t.find("tbody tr").each((_, tr) => {
    const cells = [];
    $(tr).find("td").each((_, td) => cells.push($(td).text().replace(/\s+/g, " ").trim()));
    const label = norm(cells[0] || "");
    if (label) rows.set(label, cells);
  });
  return { headers, rows };
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z%& ]+/g, "").replace(/\s+/g, " ").trim();

/** Index of the column whose header matches /mar\s*2026/i (the FY26 annual column). */
function columnIndexFor(headers, re) {
  for (let i = 0; i < headers.length; i++) if (re.test(headers[i])) return i;
  return -1;
}

/** Value of the first row whose normalised label includes any of `labels`, at column `col`. */
function rowVal(table, labels, col) {
  if (!table || col < 0) return null;
  for (const [label, cells] of table.rows) {
    if (labels.some((l) => label.includes(l))) return parseNum(cells[col]);
  }
  return null;
}

// ── page parse ───────────────────────────────────────────────────────────────
/** Parse a Screener company-page HTML into the raw pieces the bundle needs. */
export function parseCompanyPage(html) {
  const $ = cheerio.load(html);
  const notes = [];

  const name = $("h1").first().text().trim() || null;
  // Sector / industry: Screener links these under the company header (best-effort).
  const sectorLinks = $('a[href*="/company/compare/"]').map((_, a) => $(a).text().trim()).get().filter(Boolean);
  const sector = sectorLinks[0] || null;
  const sub_sector = sectorLinks[1] || null;

  // Top ratios: label → number.
  const ratios = {};
  $("#top-ratios li").each((_, li) => {
    const label = norm($(li).find(".name").text() || $(li).children().first().text());
    const num = parseNum($(li).find(".number").first().text());
    if (label) ratios[label] = num;
  });
  const cmp = ratios["current price"] ?? null;
  const market_cap_cr = ratios["market cap"] ?? null;
  const shares_out_cr = cmp && market_cap_cr ? market_cap_cr / cmp : null; // cr shares = mktcap(₹cr)/price(₹)
  if (!cmp) notes.push("current price not found in top-ratios");
  if (!market_cap_cr) notes.push("market cap not found in top-ratios");

  // P&L — FY26 = the "Mar 2026" column.
  const pnl = readTable($, "profit-loss");
  const pcol = pnl ? columnIndexFor(pnl.headers, /mar\s*2026/i) : -1;
  if (pnl && pcol < 0) notes.push("no 'Mar 2026' column in P&L — FY26 actuals may be unreported");
  const revenue = rowVal(pnl, ["sales", "revenue"], pcol);
  const ebitda = rowVal(pnl, ["operating profit"], pcol);
  const ebitda_margin_pct = rowVal(pnl, ["opm"], pcol);
  const pat = rowVal(pnl, ["net profit"], pcol);
  const net_margin_pct = pat != null && revenue ? (pat / revenue) * 100 : null;
  // Screener P&L has no gross margin line — leave null, never fabricate.
  const gross_margin_pct = null;

  // Balance sheet — net debt = borrowings − cash (cash rarely on the condensed BS).
  const bs = readTable($, "balance-sheet");
  const bcol = bs ? columnIndexFor(bs.headers, /mar\s*2026/i) : -1;
  const borrowings = rowVal(bs, ["borrowings"], bcol);
  const cash = rowVal(bs, ["cash equivalents", "cash and bank", "cash & bank", "cash"], bcol);
  let net_debt_cr = null;
  let net_debt_note = null;
  if (borrowings != null && cash != null) net_debt_cr = borrowings - cash;
  else if (borrowings != null) { net_debt_cr = borrowings; net_debt_note = "cash not on Screener condensed balance sheet — net debt approximated as gross borrowings"; }
  else notes.push("borrowings not found in balance sheet");

  // Concalls — latest transcript + PPT + date.
  const concalls = parseConcalls($);
  if (!concalls.entries.length) notes.push("no concall documents found in Documents → Concalls");

  // Valuation context for Step 9's F (current P/E + history/peer medians). Best-effort, never fatal.
  const valuation_context = parseValuationContext($, ratios);

  return {
    name, sector, sub_sector,
    inputs: { cmp, cmp_date: null, shares_out_cr, market_cap_cr, net_debt_cr, net_debt_note, borrowings, cash },
    fy26a: { revenue, ebitda, ebitda_margin_pct, pat, net_margin_pct, gross_margin_pct },
    concalls,
    valuation_context,
    notes,
  };
}

/**
 * Best-effort valuation context for Step 9's F: the company's current (trailing) P/E, its historical
 * median P/E, and the peer-median P/E from Screener's peer-comparison table. Screener exposes the
 * peer median reliably in HTML; the company's 5-yr median P/E is often chart-only, so it may be null.
 * Never throws, never fabricates — a missing field is null with a note.
 */
export function parseValuationContext($, ratios) {
  const notes = [];
  const current_pe = ratios?.["stock pe"] ?? ratios?.["price to earning"] ?? ratios?.["pe"] ?? null;
  if (current_pe == null) notes.push("current P/E not in top-ratios");
  // Historical median P/E — occasionally surfaced as a top-ratio; usually chart-only (then null).
  // Scan every top-ratio key for one mentioning both "median" and "pe" before giving up.
  let hist_median_pe = ratios?.["median pe"] ?? ratios?.["pe median"] ?? null;
  if (hist_median_pe == null && ratios) {
    const k = Object.keys(ratios).find((key) => /median/.test(key) && /\bpe\b/.test(key));
    if (k) hist_median_pe = ratios[k];
  }
  if (hist_median_pe == null) notes.push("historical median P/E not in page HTML (chart-only) — left null");

  // Peer comparison table. Find it by the explicit #peers section, else by signature (a data-table
  // with a P/E column AND a "Median" row), which survives Screener markup shifts / lazy loading.
  const peers = [];
  let peer_median_pe = null;
  try {
    const $t = findPeersTable($);
    if ($t && $t.length) {
      const headers = $t.find("thead th").map((_, th) => $(th).text().replace(/\s+/g, " ").trim()).get();
      const peCol = peColumnIndex(headers);
      // The name column is "Name" if present, else the first column (the "S.No." column, when it
      // exists, pushes both the company names AND the "Median …" label into column 1).
      const nameCol = Math.max(0, headers.findIndex((h) => /name/i.test(h)));
      if (peCol < 0) notes.push("peer table found but no P/E column");
      $t.find("tbody tr").each((_, tr) => {
        const cells = $(tr).find("td").map((_, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
        const label = (cells[nameCol] || "").toLowerCase();
        const pe = peCol >= 0 ? parseNum(cells[peCol]) : null;
        if (/median/.test(label)) peer_median_pe = pe;
        else if (label && pe != null) peers.push({ name: cells[nameCol], pe });
      });
      // Fall back to computing the median from the peer rows if Screener didn't render a Median row.
      if (peer_median_pe == null && peers.length) {
        const vals = peers.map((p) => p.pe).filter((n) => typeof n === "number").sort((a, b) => a - b);
        if (vals.length) { const mid = Math.floor(vals.length / 2); peer_median_pe = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2; }
      }
    } else notes.push("no peer comparison table on the page (may be lazy-loaded and not captured)");
  } catch (e) {
    notes.push(`peer table parse failed: ${e.message}`);
  }

  // When the peer median couldn't be read, dump a bounded snapshot of the page's tables + the
  // #peers section so the next artifact reveals Screener's real structure (this runs blind in CI).
  if (peer_median_pe == null) {
    try {
      const sigs = $("table.data-table").map((_, t) => $(t).find("thead th").map((_, th) => $(th).text().trim()).get().join("|")).get();
      notes.push(`DIAG peers: #peers=${$("#peers").length} rows=${$("#peers table tbody tr").length}; data-tables=[${sigs.map((s) => `(${s})`).join(" ")}]`);
      const snip = ($("#peers").html() || "").replace(/\s+/g, " ").trim().slice(0, 800);
      if (snip) notes.push(`DIAG peers-html: ${snip}`);
    } catch { /* diagnostics are best-effort */ }
  }

  return { current_pe, hist_median_pe, peer_median_pe, peers: peers.slice(0, 12), notes };
}

/** Index of a table's P/E column (matches "P/E", "PE", "P/E TTM"), not P/B or PEG. */
function peColumnIndex(headers) {
  return headers.findIndex((h) => /^p\s*\/?\s*e(\s*ttm)?$/i.test(String(h).replace(/\s+/g, " ").trim()) || /^pe$/i.test(String(h).replace(/\s+/g, "")));
}

/** Locate Screener's peer-comparison table: the explicit #peers section, else the first data-table
 *  whose header has a P/E column AND whose body has a "Median" row (the peer-table signature). */
function findPeersTable($) {
  const explicit = $("#peers table, section#peers table, [id*='peers'] table").filter((_, t) => $(t).find("thead th").length).first();
  if (explicit && explicit.length) return explicit;
  let found = null;
  $("table.data-table").each((_, t) => {
    if (found) return;
    const $t = $(t);
    const headers = $t.find("thead th").map((_, th) => $(th).text().trim()).get();
    // "Median" may sit in any column (an S.No. column shifts it) — match the whole row text.
    const hasMedian = $t.find("tbody tr").filter((_, tr) => /median/i.test($(tr).text())).length > 0;
    if (peColumnIndex(headers) >= 0 && hasMedian) found = $t;
  });
  return found;
}

/** Parse the Documents → Concalls list. Returns { entries: [{date, iso, transcript, ppt, title}] } newest-first. */
function parseConcalls($) {
  const entries = [];
  const $list = $(".documents.concalls, .concalls").first();
  const $items = $list.find("li").length ? $list.find("li") : $list.find(".flex-row, .flex");
  $items.each((_, li) => {
    const $li = $(li);
    const text = $li.text().replace(/\s+/g, " ").trim();
    const d = parseLooseDate(text);
    const links = {};
    $li.find("a").each((_, a) => {
      const label = $(a).text().trim().toLowerCase();
      const href = $(a).attr("href") || "";
      if (!href) return;
      const abs = href.startsWith("http") ? href : `${BASE}${href}`;
      if (label.includes("transcript")) links.transcript = abs;
      else if (label.includes("ppt") || label.includes("presentation")) links.ppt = abs;
      else if (label.includes("notes")) links.notes = abs;
    });
    if (d || links.transcript || links.ppt) {
      entries.push({ date: d?.iso || null, y: d?.y ?? null, m: d?.m ?? null, title: text.slice(0, 120), transcript: links.transcript || null, ppt: links.ppt || null });
    }
  });
  // Newest first (Screener already lists newest-first, but sort defensively by date when present).
  entries.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return { entries };
}
