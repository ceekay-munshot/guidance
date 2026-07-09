// fetchers.mjs — robust document fetching with a fallback chain.
// Order: direct (BSE/NSE, per-host Referer + warmed cookies via `directGet`) → Firecrawl → Scrape.do.
// `directGet(url, headers) => Promise<Buffer>` is injected by the caller (a Playwright request
// context that has visited nseindia.com to defeat hotlink 403s), so this module has no Playwright dep.

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function refererFor(url) {
  if (/bseindia\.com/i.test(url)) return "https://www.bseindia.com/";
  if (/nseindia\.com/i.test(url)) return "https://www.nseindia.com/";
  return undefined;
}

const looksLikePdf = (buf) => buf && buf.length > 4 && buf.subarray(0, 5).toString("latin1").startsWith("%PDF");

/** fetch() with an abort timeout. */
async function timedFetch(url, opts = {}, ms = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Firecrawl /scrape — parses a URL (incl. PDFs) to markdown text. */
async function firecrawlScrape(url, key) {
  const res = await timedFetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false }),
  }, 90000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return j?.data?.markdown || j?.markdown || "";
}

/** Scrape.do proxy — returns the target's raw bytes through a residential proxy. */
async function scrapedoGet(url, key) {
  const proxied = `https://api.scrape.do/?token=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}`;
  const res = await timedFetch(proxied, { headers: { Accept: "application/pdf,*/*" } }, 90000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Fetch a document (PDF) through the fallback chain. Returns
 *   { bytes|null, text|null, via, attempts[] } — `bytes` for pdfjs, or `text` already extracted.
 * Never throws; every failed hop is recorded in `attempts` for the evidence log.
 */
export async function fetchDoc(url, { directGet, firecrawlKey, scrapedoKey } = {}) {
  const attempts = [];

  if (typeof directGet === "function") {
    try {
      const buf = await directGet(url, { Referer: refererFor(url), "User-Agent": UA, Accept: "application/pdf,*/*" });
      if (looksLikePdf(buf)) return { bytes: buf, text: null, via: "direct", attempts };
      attempts.push(`direct: ${buf ? buf.length : 0} bytes, not a PDF`);
    } catch (e) {
      attempts.push(`direct: ${e.message}`);
    }
  }

  if (firecrawlKey) {
    try {
      const text = await firecrawlScrape(url, firecrawlKey);
      if (text && text.trim().length > 200) return { bytes: null, text: text.trim(), via: "firecrawl", attempts };
      attempts.push(`firecrawl: text too short (${text ? text.length : 0})`);
    } catch (e) {
      attempts.push(`firecrawl: ${e.message}`);
    }
  } else attempts.push("firecrawl: no FIRECRAWL_API_KEY");

  if (scrapedoKey) {
    try {
      const buf = await scrapedoGet(url, scrapedoKey);
      if (looksLikePdf(buf)) return { bytes: buf, text: null, via: "scrapedo", attempts };
      attempts.push(`scrapedo: ${buf ? buf.length : 0} bytes, not a PDF`);
    } catch (e) {
      attempts.push(`scrapedo: ${e.message}`);
    }
  } else attempts.push("scrapedo: no SCRAPEDO_API_KEY");

  return { bytes: null, text: null, via: null, attempts };
}

/** Generic HTML GET through Firecrawl/Scrape.do (used if a direct Screener fetch is blocked). */
export async function fetchHtmlFallback(url, { firecrawlKey, scrapedoKey } = {}) {
  if (firecrawlKey) {
    try {
      const md = await firecrawlScrape(url, firecrawlKey);
      if (md) return { html: null, markdown: md, via: "firecrawl" };
    } catch { /* fall through */ }
  }
  if (scrapedoKey) {
    try {
      const buf = await scrapedoGet(url, scrapedoKey);
      if (buf?.length) return { html: buf.toString("utf8"), markdown: null, via: "scrapedo" };
    } catch { /* fall through */ }
  }
  return { html: null, markdown: null, via: null };
}
