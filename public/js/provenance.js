// provenance.js — pure, DOM-free helpers for source traceability.
//
// Every source-bearing fact can carry a verbatim `quote` (copied word-for-word from the source) and,
// for Web facts, a `source_url`. These helpers resolve the document a fact points to and build a link
// that lands the reader as close to the quote as the medium allows:
//   • HTML page → a Chromium "scroll-to-text" fragment (#:~:text=…) that highlights the sentence.
//   • PDF (transcript / deck) → the plain URL; browsers can't deep-link inside a PDF, so the UI shows
//     the verbatim quote with a "copy to search" affordance and the reader Ctrl+Fs it.
// Importable in Node (tests) and by both report.js (UI) and export.js.

/** The document URL a fact's source points to. Transcript/PPT → the report-level doc URLs; Web → the
 *  fact's own source_url; Est./unknown → the fact's source_url if any, else null. */
export function resolveSourceUrl(source, fact, meta) {
  const own = (fact && fact.source_url) || null;
  const sources = (meta && meta.sources) || {};
  if (source === "Transcript") return sources.transcript_url || own || null;
  if (source === "PPT") return sources.ppt_url || own || null;
  if (source === "Web") return own || null;
  return own || null; // Est. or unknown
}

/** Heuristic: does this URL point at a PDF? (PDFs can't be text-deep-linked — open + Ctrl+F instead.) */
export function isPdfUrl(url) {
  return typeof url === "string" && /\.pdf(\?|#|$)/i.test(url);
}

/**
 * Build a Chromium scroll-to-text fragment for an HTML page. For long quotes we emit a
 * `textStart,textEnd` range (first/last few words) so an exact full-string match isn't required —
 * more robust against minor whitespace/markup differences on the page. Commas and hyphens (the
 * fragment grammar's delimiters) are percent-encoded.
 */
export function textFragment(quote) {
  const q = String(quote || "").trim().replace(/\s+/g, " ");
  if (!q) return "";
  const enc = (s) => encodeURIComponent(s).replace(/-/g, "%2D");
  const words = q.split(" ");
  if (words.length <= 8) return `#:~:text=${enc(q)}`;
  const start = words.slice(0, 5).join(" ");
  const end = words.slice(-5).join(" ");
  return `#:~:text=${enc(start)},${enc(end)}`;
}

/**
 * The full link model for a fact's source:
 *   { source, url, kind, quote, href, canDeepLink }
 * kind: "html" (href scrolls to & highlights the quote), "pdf" (open, then Ctrl+F the quote), or
 * "none" (no linkable source — e.g. an Est./derived fact). `quote` falls back to `anchor`
 * (management-tone items store their verbatim quote there).
 */
export function buildSourceLink(fact, meta) {
  const f = fact || {};
  const source = f.source || null;
  const quote = f.quote ? String(f.quote) : f.anchor ? String(f.anchor) : "";
  const url = resolveSourceUrl(source, f, meta);
  if (!url) return { source, url: null, kind: "none", quote, href: null, canDeepLink: false };
  const pdf = isPdfUrl(url);
  const frag = !pdf && quote ? textFragment(quote) : "";
  return { source, url, kind: pdf ? "pdf" : "html", quote, href: url + frag, canDeepLink: !pdf && !!frag };
}

/** Collect the report's web sources for a Sources panel: prefer meta.sources.web, else derive the
 *  unique source_urls that Web-facts reference. Returns [{url, title}] (title falls back to the host). */
export function collectWebSources(report) {
  const r = report || {};
  const listed = (r.meta && r.meta.sources && Array.isArray(r.meta.sources.web)) ? r.meta.sources.web : [];
  const seen = new Map();
  for (const w of listed) if (w && w.url && !seen.has(w.url)) seen.set(w.url, { url: w.url, title: w.title || hostOf(w.url) });
  const facts = [
    ...((r.concall && r.concall.risks) || []),
    ...(r.thesis || []),
    ...(r.anti_thesis || []),
    ...((r.concall && r.concall.themes) || []),
  ];
  for (const f of facts) if (f && f.source === "Web" && f.source_url && !seen.has(f.source_url)) seen.set(f.source_url, { url: f.source_url, title: hostOf(f.source_url) });
  return [...seen.values()];
}

/** Best-effort hostname for a URL (never throws). */
export function hostOf(url) {
  const m = String(url || "").match(/^https?:\/\/([^/]+)/i);
  return m ? m[1].replace(/^www\./, "") : String(url || "");
}
