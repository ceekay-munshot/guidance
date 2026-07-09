// analyze.js — pure, testable helpers for the Analyze → poll flow (STEP 10 GO-LIVE).
// Used by app.js; unit-tested without a DOM. `slugify` is kept identical to the Worker
// (worker/index.js) and the pipeline (pipeline/lib/util.mjs) so one company maps to ONE
// KV key everywhere (report:<slug> / status:<slug>).

/** URL-safe slug from a company name/ticker. Must match the Worker + pipeline exactly. */
export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "company";
}

/**
 * Resolve the analysis target from a universe selection OR free text. A universe pick keeps its
 * canonical slug; free text is slugified. Returns { name, ticker, slug } or null when empty.
 */
export function resolveTarget(selected, inputText) {
  if (selected && selected.slug) return { name: selected.name, ticker: selected.ticker || "", slug: selected.slug };
  const name = String(inputText || "").trim();
  return name ? { name, ticker: "", slug: slugify(name) } : null;
}

/**
 * Decide what the poll loop should do given a GET /api/report body:
 *   done   → render the report; error → stop + show message; wait → keep polling.
 * Unknown/queued/running all mean "not ready yet" (KV is read-after-write, but tolerate lag).
 */
export function pollDecision(body) {
  const st = body && body.status;
  if (st === "done" && body.report) return { action: "done", report: body.report };
  if (st === "error") return { action: "error", message: body.error || body.message || "Analysis failed." };
  if (st === "queued" || st === "running" || st === "unknown") return { action: "wait", status: st };
  return { action: "error", message: "Unexpected response from the server." };
}
