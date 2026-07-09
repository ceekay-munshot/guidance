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

  return {
    name, sector, sub_sector,
    inputs: { cmp, cmp_date: null, shares_out_cr, market_cap_cr, net_debt_cr, net_debt_note, borrowings, cash },
    fy26a: { revenue, ebitda, ebitda_margin_pct, pat, net_margin_pct, gross_margin_pct },
    concalls,
    notes,
  };
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
