// websearch.mjs — medium-depth web research for Step 8. Two providers, tried in order per query:
//   1. OpenAI Responses API with the built-in `web_search` tool (preferred — model searches + cites).
//   2. Firecrawl /v1/search (FIRECRAWL_API_KEY) — title + snippet + URL per hit.
// gatherWebContext() runs a handful of TARGETED queries and returns a single context blob (with
// inline source URLs) plus a flat citation list. Never throws; a dead provider just yields less
// context and the caller degrades (risks may end up empty — never fabricated).

/** fetch() with an abort timeout. */
async function timedFetch(url, opts = {}, ms = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * One OpenAI Responses call with the web_search tool. Returns { text, citations:[{url,title}], usage }.
 * Throws on HTTP error so the caller can fall back to Firecrawl.
 */
export async function openaiWebSearch({ apiKey, model, query, timeoutMs = 90000 }) {
  const res = await timedFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      input: `Search the web and report concise, factual findings for this query about an Indian listed company. Include the most relevant specifics (dates, amounts, order numbers) and rely only on what the sources say.\n\nQUERY: ${query}`,
    }),
  }, timeoutMs);
  if (!res.ok) throw new Error(`responses HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return { text: extractResponsesText(j), citations: extractResponsesCitations(j), usage: j.usage || {} };
}

/** Pull the assistant text out of a Responses payload (convenience field, else walk output[]). */
function extractResponsesText(j) {
  if (typeof j.output_text === "string" && j.output_text.trim()) return j.output_text.trim();
  const parts = [];
  for (const item of j.output || []) {
    for (const c of item.content || []) {
      if (c.type === "output_text" && c.text) parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

/** Collect url_citation annotations (dedup by URL) from a Responses payload. */
function extractResponsesCitations(j) {
  const out = [];
  const seen = new Set();
  for (const item of j.output || []) {
    for (const c of item.content || []) {
      for (const a of c.annotations || []) {
        if (a.type === "url_citation" && a.url && !seen.has(a.url)) {
          seen.add(a.url);
          out.push({ url: a.url, title: a.title || "" });
        }
      }
    }
  }
  return out;
}

/** Firecrawl /v1/search — returns [{url,title,snippet}] for a query. Throws on HTTP error. */
export async function firecrawlSearch({ key, query, limit = 5, timeoutMs = 60000 }) {
  const res = await timedFetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, limit }),
  }, timeoutMs);
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  const j = await res.json();
  const rows = j?.data || j?.results || [];
  return rows.map((r) => ({ url: r.url || r.link || "", title: r.title || "", snippet: r.description || r.snippet || r.markdown || "" }))
    .filter((r) => r.url);
}

/**
 * Run each query through OpenAI web_search (fallback Firecrawl) and aggregate. Returns
 *   { context, citations:[{url,title,query}], provider, perQuery:[{query,via,chars,hits}], usage }
 * `context` is a plain-text blob (findings + inline source URLs) safe to feed the extractor.
 * Deterministic given the same responses (order preserved); never throws.
 */
export async function gatherWebContext({ queries, openaiKey, model, firecrawlKey, log } = {}) {
  const blocks = [];
  const citations = [];
  const perQuery = [];
  let inTok = 0, outTok = 0;
  const note = (m) => { if (log) log.info(m); };

  for (const query of queries) {
    let handled = false;

    if (openaiKey) {
      try {
        const { text, citations: cites, usage } = await openaiWebSearch({ apiKey: openaiKey, model, query });
        inTok += usage.input_tokens || usage.prompt_tokens || 0;
        outTok += usage.output_tokens || usage.completion_tokens || 0;
        if (text) {
          const urls = cites.length ? cites : [];
          blocks.push(renderBlock(query, text, urls));
          urls.forEach((c) => citations.push({ ...c, query }));
          perQuery.push({ query, via: "openai_web_search", chars: text.length, hits: urls.length });
          note(`web_search "${query}" → ${text.length} chars, ${urls.length} citations`);
          handled = true;
        }
      } catch (e) {
        note(`web_search "${query}" failed (${e.message}) — trying Firecrawl`);
      }
    }

    if (!handled && firecrawlKey) {
      try {
        const hits = await firecrawlSearch({ key: firecrawlKey, query });
        if (hits.length) {
          const text = hits.map((h) => `- ${h.title || h.url}: ${h.snippet}`.trim()).join("\n");
          blocks.push(renderBlock(query, text, hits));
          hits.forEach((h) => citations.push({ url: h.url, title: h.title, query }));
          perQuery.push({ query, via: "firecrawl_search", chars: text.length, hits: hits.length });
          note(`firecrawl "${query}" → ${hits.length} hits`);
          handled = true;
        }
      } catch (e) {
        note(`firecrawl "${query}" failed (${e.message})`);
      }
    }

    if (!handled) perQuery.push({ query, via: null, chars: 0, hits: 0 });
  }

  const provider = perQuery.some((q) => q.via === "openai_web_search") ? "openai_web_search"
    : perQuery.some((q) => q.via === "firecrawl_search") ? "firecrawl_search" : "none";
  return { context: blocks.join("\n\n"), citations, provider, perQuery, usage: { input_tokens: inTok, output_tokens: outTok } };
}

function renderBlock(query, text, urls) {
  const src = urls.length ? `\nSOURCES: ${urls.map((u) => u.url).join(" | ")}` : "";
  return `### QUERY: ${query}\n${text}${src}`;
}

/** Build the targeted research queries for one company (risks off-call + a couple thesis angles). */
export function researchQueries(company, sector) {
  const c = company || "the company";
  return [
    `${c} pending litigation OR court case OR arbitration`,
    `${c} SEBI order OR show cause OR adjudication`,
    `${c} promoter pledge OR promoter stake sale OR shareholding change`,
    `${c} credit rating CRISIL OR ICRA OR CARE rating action`,
    `${c} related party transactions OR governance concern`,
    `${c} ${sector || ""} competition OR new capacity OR industry oversupply`.trim(),
  ];
}
