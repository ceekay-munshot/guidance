// app.js — Munshot · Concall Deep Dive (STEP 10 — GO LIVE)
// Landing shell: universe load, a production-grade type-ahead search (with free-text),
// and a real idle → queued → polling → loaded/error run-state machine that dispatches the
// GitHub Action via the Worker and renders the REAL per-company report from KV. On first
// load it shows the sample report as a demo; a live run replaces it.

import { qs, qsa, sleep, debounce, escapeHtml, highlightMatch, renderIcons, show, clamp } from "./ui.js";
import { renderReport, hydrateModel } from "./report.js";
import { resolveTarget, pollDecision } from "./analyze.js";

// ── Config ──────────────────────────────────────────────────────────────────
const MAX_RESULTS = 8;        // cap the visible suggestion list
const POPULAR_COUNT = 6;      // "Popular" rows shown on empty-query focus
const POLL_INTERVAL_MS = 2500;
// The real pipeline (Screener fetch + several LLM calls) usually finishes in ~1–2 min;
// allow generous headroom before surfacing a timeout the user can retry from.
const POLL_TIMEOUT_MS = 240000; // 4 min

// ── API client (talks to worker/index.js) ────────────────────────────────────
const api = {
  async universe() {
    const res = await fetch("/api/universe");
    if (!res.ok) throw new Error(`/api/universe → ${res.status}`);
    return res.json();
  },
  // Dispatch (or reuse) a run. target = { name, ticker }; force (a real boolean) re-runs a fresh
  // report. The Worker derives the KV slug from the company itself, so we don't send one.
  async analyze(target, force = false) {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: target.name, ticker: target.ticker, force: force === true }),
    });
    let body = {};
    try { body = await res.json(); } catch { /* empty */ }
    if (!res.ok && body.status !== "queued" && body.status !== "done") {
      throw new Error(body.error || `/api/analyze → ${res.status}`);
    }
    return body; // { ok, slug, status: "queued" | "done" | "running" | "error" }
  },
  // One poll tick → a pollDecision ({ action: "done"|"wait"|"error", … }). A hard transport
  // failure with no status body is thrown so the UI surfaces it instead of polling to timeout.
  async reportTick(slug) {
    const res = await fetch(`/api/report?slug=${encodeURIComponent(slug)}`);
    let body = {};
    try { body = await res.json(); } catch { /* empty */ }
    if (!res.ok && !body.status) throw new Error(body.error || `report fetch failed (HTTP ${res.status})`);
    return pollDecision(body);
  },
};

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  universe: [],
  selected: null,  // a REAL universe entry, or null (free text never selects)
  running: false,
  shownSlug: null, // slug of the report/error currently rendered in #report-root
};

// Type-ahead sub-state.
const search = {
  open: false,
  items: [],      // currently listed, selectable universe entries
  active: -1,     // highlighted index into items
  mode: "idle",   // "popular" | "matches" | "empty"
  truncated: 0,   // matches hidden beyond MAX_RESULTS
  query: "",      // the input value the current list was rendered for (staleness check)
};

let runToken = 0; // bumped each run → stale poll loops / renders bail out

const els = {};
function cacheEls() {
  els.input = qs("#company-search");
  els.results = qs("#search-results");
  els.clear = qs("#clear-btn");
  els.run = qs("#run-btn");
  els.chip = qs("#selected-chip");
  els.chipName = qs("#selected-name");
  els.chipTicker = qs("#selected-ticker");
  els.reportRoot = qs("#report-root");
}

// ── Type-ahead: compute + render ──────────────────────────────────────────────
function computeList(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    search.mode = "popular";
    search.items = state.universe.slice(0, POPULAR_COUNT);
    search.truncated = 0;
    return;
  }
  const all = state.universe.filter(
    (c) => c.name.toLowerCase().includes(q) || c.ticker.toLowerCase().includes(q)
  );
  search.items = all.slice(0, MAX_RESULTS);
  search.truncated = Math.max(0, all.length - MAX_RESULTS);
  search.mode = all.length === 0 ? "empty" : "matches";
}

function rowHtml(c, i, query) {
  return `
    <li role="option" data-slug="${escapeHtml(c.slug)}" data-index="${i}" aria-selected="false"
        class="typeahead-item cursor-pointer rounded-xl px-3 py-2 flex items-center justify-between gap-3">
      <span class="min-w-0">
        <span class="block truncate font-medium">${highlightMatch(c.name, query)}</span>
        <span class="font-mono text-xs text-slate-400">${highlightMatch(c.ticker, query)}</span>
      </span>
      <span class="text-xs text-slate-400 shrink-0 text-right max-w-[9rem] truncate">${escapeHtml(c.sector)}</span>
    </li>`;
}

function renderList(query) {
  const parts = [];
  if (search.mode === "popular") {
    parts.push(`<li class="px-3 pt-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Popular</li>`);
  }
  if (search.mode === "empty") {
    parts.push(`
      <li class="px-3 py-3 text-sm text-slate-500 flex items-center gap-2">
        <i data-lucide="search-x" class="w-4 h-4 text-slate-400"></i>
        No matches for “${escapeHtml(query.trim())}”.
      </li>`);
  } else {
    search.items.forEach((c, i) => parts.push(rowHtml(c, i, query)));
    if (search.truncated > 0) {
      parts.push(`
        <li class="px-3 pt-2 pb-1 mt-1 text-xs text-slate-400 border-t border-slate-100">
          +${search.truncated} more — keep typing to narrow…
        </li>`);
    }
  }
  els.results.innerHTML = parts.join("");
  els.results.classList.remove("hidden");
  paintActive();
  renderIcons();
}

function openList(query) {
  computeList(query);
  search.query = query;
  search.active = search.items.length ? 0 : -1;
  search.open = true;
  els.input.setAttribute("aria-expanded", "true");
  renderList(query);
}

function closeList() {
  search.open = false;
  search.active = -1;
  els.results.classList.add("hidden");
  els.results.innerHTML = "";
  els.input.setAttribute("aria-expanded", "false");
}

function paintActive() {
  qsa(".typeahead-item", els.results).forEach((row) => {
    const on = Number(row.dataset.index) === search.active;
    row.setAttribute("aria-selected", on ? "true" : "false");
    if (on) row.scrollIntoView({ block: "nearest" });
  });
}

function moveActive(delta) {
  if (!search.items.length) return;
  search.active = clamp(search.active + delta, 0, search.items.length - 1);
  paintActive();
}

// ── Selection ─────────────────────────────────────────────────────────────────
function setChip(company) {
  els.chipName.textContent = company.name;
  els.chipTicker.textContent = company.ticker;
  show(els.chip, true);
  els.chip.classList.add("flex");
}
function hideChip() {
  show(els.chip, false);
  els.chip.classList.remove("flex");
}

function selectCompany(slug) {
  const company = state.universe.find((c) => c.slug === slug);
  if (!company) return; // only real universe entries can be selected
  // Changing the target company drops any report still shown for a different one.
  if (state.shownSlug && state.shownSlug !== slug) clearReport();
  state.selected = company;
  els.input.value = company.name;
  setChip(company);
  show(els.clear, true);
  els.run.disabled = false;
  closeList();
  renderIcons();
}

/** Drop the selection (typing invalidated it) without touching the input text. */
function invalidateSelection() {
  if (!state.selected) return;
  state.selected = null;
  hideChip();
  updateRunEnabled(); // free text can still run
  // Editing away from the selected company makes its report stale — clear it.
  if (state.shownSlug) clearReport();
}

function clearAll() {
  state.selected = null;
  els.input.value = "";
  hideChip();
  show(els.clear, false);
  els.run.disabled = true;
  clearReport();
  els.input.focus();
  openList(""); // show Popular so the box is never blank
}

// ── Run-state machine ─────────────────────────────────────────────────────────
/** Run is enabled when there's a universe selection OR any free-text company, and no run is active. */
function updateRunEnabled() {
  els.run.disabled = state.running || !(state.selected || els.input.value.trim());
}

function setControlsDisabled(disabled) {
  els.input.disabled = disabled;
  els.clear.disabled = disabled;
  updateRunEnabled();
}

async function runAnalyze(force = false) {
  if (state.running) return;
  const company = resolveTarget(state.selected, els.input.value);
  if (!company) return;
  const token = ++runToken; // supersede any prior in-flight run
  state.running = true;
  setControlsDisabled(true);
  closeList();
  renderAnalyzing(company);

  try {
    const dispatch = await api.analyze(company, force);
    if (token !== runToken) return;
    if (dispatch.status === "error") { renderError(company, dispatch.error || "Could not start the analysis.", "error"); return; }
    setAnalyzingNote(dispatch.status === "done" ? "Cached — fetching report…" : "Queued — this usually takes ~1–2 min…");

    // Poll the slug the Worker actually keyed (server-derived), falling back to our own.
    const report = await pollLoop(dispatch.slug || company.slug, token);
    if (token !== runToken) return;

    renderLoaded(company, report);
  } catch (err) {
    if (token !== runToken) return;
    if (err.name === "TimeoutError") renderError(company, "This is taking longer than expected. The run may still finish — try again in a minute.", "timeout");
    else renderError(company, err.message || String(err), "error");
  } finally {
    if (token === runToken) {
      state.running = false;
      setControlsDisabled(false);
    }
  }
}

async function pollLoop(slug, token) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const started = Date.now();
  while (Date.now() < deadline) {
    if (token !== runToken) return null; // superseded → bail quietly
    const decision = await api.reportTick(slug);
    if (token !== runToken) return null;

    if (decision.action === "done") return decision.report;
    if (decision.action === "error") { const e = new Error(decision.message); e.name = "AnalysisError"; throw e; }
    const secs = Math.round((Date.now() - started) / 1000);
    setAnalyzingNote(`Analyzing… ${decision.status === "running" ? "the pipeline is running" : "waiting for the pipeline"} (${secs}s).`);
    await sleep(POLL_INTERVAL_MS);
  }
  const e = new Error("timeout"); e.name = "TimeoutError"; throw e;
}

// ── Renders into #report-root ──────────────────────────────────────────────────
const skeletonRow = (w) => `<div class="h-3 ${w} rounded-full bg-slate-100 animate-pulse"></div>`;

/** Empty the report area — call whenever the shown company is no longer the target. */
function clearReport() {
  els.reportRoot.innerHTML = "";
  state.shownSlug = null;
}

function renderAnalyzing(company) {
  els.reportRoot.innerHTML = `
    <div class="card fade-in p-6 sm:p-8">
      <div class="flex items-center gap-3">
        <div class="spinner"></div>
        <div>
          <p class="font-display font-semibold text-lg">
            Analyzing ${escapeHtml(company.name)}<span class="text-slate-400 font-mono">…</span>
          </p>
          <p id="analyzing-note" class="text-sm text-slate-500">Dispatching run…</p>
        </div>
      </div>
      <div class="mt-6 space-y-3">
        ${skeletonRow("w-2/3")}
        ${skeletonRow("w-full")}
        ${skeletonRow("w-5/6")}
        ${skeletonRow("w-1/2")}
      </div>
    </div>`;
}

function setAnalyzingNote(text) {
  const n = qs("#analyzing-note");
  if (n) n.textContent = text;
}

function renderLoaded(company, report) {
  const meta = report?.meta ?? {};
  const when = meta.generated_at ? new Date(meta.generated_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : null;
  // Subtle freshness line + a regenerate affordance (re-runs the pipeline, bypassing the cache).
  const bar = `
    <div class="fade-in mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
      <span>${when ? `Generated ${escapeHtml(when)}` : "Live report"} · served from cache when fresh</span>
      <button id="regen-btn" type="button" class="inline-flex items-center gap-1.5 rounded-full ring-1 ring-inset ring-slate-200 px-3 py-1 font-semibold text-slate-500 hover:bg-slate-50">
        <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i>Regenerate
      </button>
    </div>`;
  els.reportRoot.innerHTML = bar + renderReport(report);
  state.shownSlug = company.slug;
  renderIcons();
  hydrateModel(report, els.reportRoot); // wire Section E's editable model → live E + F recompute
  const regen = qs("#regen-btn");
  if (regen) regen.addEventListener("click", () => { if (!state.running) runAnalyze(true); });
}

function renderError(company, message, kind /* "timeout" | "error" */) {
  const icon = kind === "timeout" ? "clock" : "alert-triangle";
  const title = kind === "timeout" ? "Analysis timed out" : "Couldn't load the report";
  els.reportRoot.innerHTML = `
    <div class="card fade-in p-6 sm:p-8 border border-rose-100">
      <div class="flex items-center gap-2 text-rose-600 font-medium mb-2">
        <i data-lucide="${icon}" class="w-5 h-5"></i>
        <span>${title}</span>
      </div>
      <p class="text-slate-500 text-sm">${escapeHtml(company.name)} — ${escapeHtml(message)}</p>
      <button id="retry-btn" type="button" class="btn-primary font-semibold px-5 py-2.5 mt-5 inline-flex items-center gap-2">
        <i data-lucide="rotate-ccw" class="w-4 h-4"></i>
        Try again
      </button>
    </div>`;
  state.shownSlug = company.slug;
  renderIcons();
  const retry = qs("#retry-btn");
  if (retry) retry.addEventListener("click", () => { if (!state.running) runAnalyze(); });
}

/** First-load demo — render the bundled sample so the dashboard isn't empty; a live run replaces it. */
async function renderDemo() {
  try {
    const res = await fetch("/data/sample-report.json");
    if (!res.ok) return;
    const sample = await res.json();
    const banner = `
      <div class="fade-in mb-4 rounded-xl bg-indigo-50/70 text-indigo-700 ring-1 ring-inset ring-indigo-100 px-4 py-2 text-xs flex items-center gap-2">
        <i data-lucide="sparkles" class="w-4 h-4"></i>
        <span>Sample report — search any listed company above and hit <span class="font-semibold">Analyze</span> for a live deep-dive.</span>
      </div>`;
    els.reportRoot.innerHTML = banner + renderReport(sample);
    renderIcons();
    hydrateModel(sample, els.reportRoot);
    state.shownSlug = null; // demo isn't tied to a slug — a real run always supersedes it
  } catch { /* demo is best-effort */ }
}

// ── Events ──────────────────────────────────────────────────────────────────────
// Synchronous on every keystroke: invalidate a stale selection immediately so that
// Run/Enter in the debounce window can't dispatch the old company. Only the expensive
// list render is debounced.
function onInputSync() {
  if (state.selected && els.input.value !== state.selected.name) invalidateSelection();
  show(els.clear, els.input.value.length > 0);
  updateRunEnabled(); // free text enables Run even without a universe pick
}
const onInputRender = debounce(() => openList(els.input.value), 80);

function onKeydown(e) {
  if (!search.open && e.key === "ArrowDown") {
    openList(els.input.value);
    e.preventDefault();
    return;
  }
  switch (e.key) {
    case "ArrowDown": e.preventDefault(); moveActive(1); break;
    case "ArrowUp": e.preventDefault(); moveActive(-1); break;
    case "Enter":
      e.preventDefault();
      // Flush a pending debounced render so Enter acts on the CURRENT input, not a
      // stale list left over from a previous query (fast type-then-Enter).
      if (search.open && search.query !== els.input.value) openList(els.input.value);
      if (search.open && search.active >= 0 && search.items[search.active]) {
        selectCompany(search.items[search.active].slug);
      } else if (state.selected && !state.running) {
        runAnalyze();
      }
      break;
    case "Escape": closeList(); break;
    default: break;
  }
}

function wireEvents() {
  els.input.addEventListener("input", () => { onInputSync(); onInputRender(); });
  els.input.addEventListener("focus", () => { if (!state.running) openList(els.input.value); });
  els.input.addEventListener("keydown", onKeydown);

  els.results.addEventListener("click", (e) => {
    const item = e.target.closest(".typeahead-item");
    if (item) selectCompany(item.dataset.slug);
  });
  // Hover mirrors keyboard active state so Enter selects the hovered row.
  els.results.addEventListener("mouseover", (e) => {
    const item = e.target.closest(".typeahead-item");
    if (!item) return;
    const idx = Number(item.dataset.index);
    if (idx !== search.active) { search.active = idx; paintActive(); }
  });

  els.clear.addEventListener("click", clearAll);
  els.run.addEventListener("click", () => runAnalyze()); // wrap: don't pass the MouseEvent as `force`

  // Click-outside closes the dropdown.
  document.addEventListener("click", (e) => {
    if (!els.results.contains(e.target) && e.target !== els.input) closeList();
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────────
async function init() {
  cacheEls();
  wireEvents();
  renderIcons();
  renderDemo(); // show the sample immediately so the landing isn't blank
  try {
    state.universe = await api.universe();
    els.input.placeholder = `Search ${state.universe.length} companies — or type any name/ticker…`;
  } catch (err) {
    console.error("[munshot] failed to load universe:", err);
    els.reportRoot.innerHTML = `
      <div class="card fade-in p-6 border border-rose-100">
        <p class="text-rose-600 font-medium">Couldn't load the company list.</p>
        <p class="text-slate-500 text-sm mt-1">${escapeHtml(err.message || String(err))}</p>
      </div>`;
  }
}

document.addEventListener("DOMContentLoaded", init);
