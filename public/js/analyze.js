// analyze.js — pure, testable helpers for the Analyze → poll → library flow (Steps 10–11).
// No DOM here; app.js imports these. slugify is kept identical to the Worker (worker/index.js) and
// pipeline (pipeline/lib/util.mjs) so one stock maps to ONE KV key everywhere.

/** URL-safe slug from a ticker/name. Must match the Worker + pipeline exactly. */
export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "company";
}

/**
 * Resolve the analysis target from a search selection OR free text. The slug is derived from the
 * TICKER when present (unique → one KV key per stock, regardless of name spelling) — the same rule
 * the Worker applies server-side. Returns { name, ticker, slug } or null when empty.
 */
export function resolveTarget(selected, inputText) {
  if (selected && (selected.ticker || selected.name)) {
    const ticker = selected.ticker || "";
    return { name: selected.name || ticker, ticker, slug: slugify(ticker || selected.name) };
  }
  const name = String(inputText || "").trim();
  return name ? { name, ticker: "", slug: slugify(name) } : null;
}

/**
 * Decide what the poll loop should do given a GET /api/report body:
 *   done → render; error → stop + show message; wait → keep polling.
 */
export function pollDecision(body) {
  const st = body && body.status;
  if (st === "done" && body.report) return { action: "done", report: body.report };
  if (st === "error") return { action: "error", message: body.error || body.message || "Analysis failed." };
  if (st === "queued" || st === "running" || st === "unknown") return { action: "wait", status: st, stage: body.stage };
  return { action: "error", message: "Unexpected response from the server." };
}

/**
 * The pipeline stages, in order, with the target % and the CLIENT-FACING label (never expose
 * internals). The Action writes `status.stage` per stage; the client derives the bar % + label here.
 */
export const STAGES = [
  { key: "queued", pct: 5, label: "Starting the analysis…" },
  { key: "resolve", pct: 15, label: "Gathering price, financials & balance sheet…" },
  { key: "transcript", pct: 30, label: "Pulling the latest earnings call & deck…" },
  { key: "extract", pct: 50, label: "Reading management's commentary…" },
  { key: "research", pct: 68, label: "Researching risks & the bull/bear case…" },
  { key: "verify", pct: 80, label: "Fact-checking every claim against the transcript…" },
  { key: "model", pct: 90, label: "Building the financial model & valuation…" },
  { key: "finalize", pct: 97, label: "Assembling your report…" },
  { key: "done", pct: 100, label: "Report ready." },
];
/** The stages shown as the vertical checklist (skip the synthetic queued/done bookends). */
export const CHECKLIST_STAGES = STAGES.filter((s) => s.key !== "queued" && s.key !== "done");

/** Resolve a stage key → { key, pct, label, index }. Unknown/blank → the "queued" start. */
export function stageInfo(stage) {
  const i = Math.max(0, STAGES.findIndex((s) => s.key === stage));
  return { ...STAGES[i], index: i };
}

/** Sort a reports-library array newest-first (tolerant of missing dates). */
export function sortReports(list) {
  return (Array.isArray(list) ? list.slice() : []).sort((a, b) => String(b && b.generated_at || "").localeCompare(String(a && a.generated_at || "")));
}

/** Human "… ago" from an ISO timestamp. `now` is injectable for testing. */
export function relativeTime(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "recently";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.round(d / 30);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
}

// ── in-flight run persistence (survives reload / tab switch) ──
const INFLIGHT_KEY = "munshot:inflight";

/** Serialize an in-flight run record → string (or "" to clear). Pure, for testing. */
export function serializeInflight(run) {
  if (!run || !run.slug) return "";
  const { slug, company, ticker, startedAt } = run;
  return JSON.stringify({ slug, company: company || "", ticker: ticker || "", startedAt: startedAt || null });
}
/** Parse a stored in-flight record → object|null. Tolerates junk. Pure, for testing. */
export function parseInflight(str) {
  if (!str) return null;
  try { const o = JSON.parse(str); return o && o.slug ? o : null; } catch { return null; }
}
/** localStorage wrappers (guarded so imports don't touch storage). */
export function saveInflight(run, storage = globalThis.localStorage) {
  try { const s = serializeInflight(run); if (s) storage.setItem(INFLIGHT_KEY, s); else storage.removeItem(INFLIGHT_KEY); } catch { /* private mode */ }
}
export function loadInflight(storage = globalThis.localStorage) {
  try { return parseInflight(storage.getItem(INFLIGHT_KEY)); } catch { return null; }
}
export function clearInflight(storage = globalThis.localStorage) {
  try { storage.removeItem(INFLIGHT_KEY); } catch { /* ignore */ }
}
