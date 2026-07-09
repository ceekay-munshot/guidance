// app.js — Munshot · Concall Deep Dive (STEP 2)
// Landing shell: universe load, a production-grade type-ahead search, and a clean
// idle → queued → polling → loaded/error run-state machine against the (stubbed)
// Worker. The report RENDERER is step 3 — the done state shows a placeholder card
// and logs the report object; it does NOT render the full report yet.

import { qs, qsa, sleep, debounce, escapeHtml, highlightMatch, renderIcons, show, clamp } from "./ui.js";
import { renderReport, hydrateModel } from "./report.js";

// ── Config ──────────────────────────────────────────────────────────────────
const MAX_RESULTS = 8;        // cap the visible suggestion list
const POPULAR_COUNT = 6;      // "Popular" rows shown on empty-query focus
const POLL_INTERVAL_MS = 1200;
// Give up (→ timeout error) after ~60s. Fine for step 2's ~4s stub. Step 10's real
// workflow_dispatch path (fetch + LLM) can exceed a minute — raise this materially
// and/or replace the hard cap with an explicit "keep waiting"/cancel affordance then.
const POLL_TIMEOUT_MS = 60000;

// ── API client (talks to worker/index.js) ────────────────────────────────────
const api = {
  async universe() {
    const res = await fetch("/api/universe");
    if (!res.ok) throw new Error(`/api/universe → ${res.status}`);
    return res.json();
  },
  async analyze(slug) {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    if (!res.ok) throw new Error(`/api/analyze → ${res.status}`);
    return res.json(); // { ok, slug, status: "queued" | "done" }
  },
  // One poll tick. 200 → { done, report }. 404 queued/unknown → { done:false, status }.
  // Any OTHER non-200 (500 asset/KV failure, 400, unexpected shape) is a real error —
  // throw it so the UI surfaces it instead of silently polling to a 60s timeout.
  async reportTick(slug) {
    const res = await fetch(`/api/report?slug=${encodeURIComponent(slug)}`);
    if (res.status === 200) return { done: true, report: await res.json() };
    let body = {};
    try { body = await res.json(); } catch { /* empty body */ }
    if (res.status === 404 && (body.status === "queued" || body.status === "unknown")) {
      return { done: false, status: body.status };
    }
    throw new Error(body.error || `report fetch failed (HTTP ${res.status})`);
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
  els.run.disabled = true;
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
function setControlsDisabled(disabled) {
  els.input.disabled = disabled;
  els.clear.disabled = disabled;
  els.run.disabled = disabled || !state.selected;
}

async function runAnalyze() {
  if (!state.selected || state.running) return;
  const company = state.selected;
  const token = ++runToken; // supersede any prior in-flight run
  state.running = true;
  setControlsDisabled(true);
  closeList();
  renderAnalyzing(company);

  try {
    const dispatch = await api.analyze(company.slug);
    if (token !== runToken) return;
    setAnalyzingNote(dispatch.status === "done" ? "Cached — fetching report…" : "Queued — waiting for the pipeline…");

    const report = await pollLoop(company.slug, token);
    if (token !== runToken) return;

    console.log("[munshot] report loaded:", report);
    renderLoaded(company, report);
  } catch (err) {
    if (token !== runToken) return;
    if (err.name === "TimeoutError") renderError(company, "Timed out after 60s waiting for the report.", "timeout");
    else if (err.name === "UnknownError") renderError(company, "No analysis job was found for this company.", "error");
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
  let attempt = 0;
  while (Date.now() < deadline) {
    if (token !== runToken) return null; // superseded → bail quietly
    attempt += 1;
    const tick = await api.reportTick(slug);
    if (token !== runToken) return null;

    if (tick.done) return tick.report;
    if (tick.status === "unknown") {
      const e = new Error("unknown"); e.name = "UnknownError"; throw e;
    }
    setAnalyzingNote(`Analyzing… still working (attempt ${attempt}).`);
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
  // The stub returns the same sample fixture for every slug. Be honest about it
  // rather than mislabel the fixture as the searched company.
  const isFixtureForOther = meta.slug && meta.slug !== company.slug;
  const note = isFixtureForOther
    ? `<div class="fade-in mb-4 rounded-xl bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 px-4 py-2 text-xs">
         You searched <span class="font-medium">${escapeHtml(company.name)}</span>, but the stub serves one
         shared sample fixture. The pipeline returns a real per-company report from step 10.
       </div>`
    : "";
  els.reportRoot.innerHTML = note + renderReport(report);
  state.shownSlug = company.slug;
  renderIcons();
  hydrateModel(report, els.reportRoot); // wire Section E's editable model → live E + F recompute
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
  if (retry) retry.addEventListener("click", () => { if (state.selected && !state.running) runAnalyze(); });
}

// ── Events ──────────────────────────────────────────────────────────────────────
// Synchronous on every keystroke: invalidate a stale selection immediately so that
// Run/Enter in the debounce window can't dispatch the old company. Only the expensive
// list render is debounced.
function onInputSync() {
  if (state.selected && els.input.value !== state.selected.name) invalidateSelection();
  show(els.clear, els.input.value.length > 0);
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
  els.run.addEventListener("click", runAnalyze);

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
  try {
    state.universe = await api.universe();
    els.input.placeholder = `Search ${state.universe.length} companies — e.g. Navin Fluorine, TCS, SRF…`;
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
