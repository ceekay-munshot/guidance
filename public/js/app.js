// app.js — Munshot · Concall Deep Dive (STEP 1)
// Wires the landing shell: load the universe, drive a type-ahead search, and run
// the real request→poll plumbing against the (stubbed) Worker API. The report
// RENDERER is step 3 — for now we console.log the payload and show a confirmation.

import { qs, qsa, sleep, debounce, escapeHtml, highlightMatch, renderIcons, show } from "./ui.js";

// ── API client (talks to worker/index.js) ─────────────────────────────────
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
    return res.json(); // { ok, slug, status: "done" | "queued" }
  },
  // One poll tick. Returns the report object when ready, or null if not-yet-ready
  // (404 / partial). Throws only on unexpected transport errors.
  async reportTick(slug) {
    const res = await fetch(`/api/report?slug=${encodeURIComponent(slug)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`/api/report → ${res.status}`);
    const data = await res.json();
    return data && data.meta ? data : null;
  },
};

/** Poll /api/report until the report is ready or we time out. */
async function pollReport(slug, { intervalMs = 1200, timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const report = await api.reportTick(slug);
    if (report) return report;
    setAnalyzingDetail(`Waiting for the report… (attempt ${attempt})`);
    await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for the report.");
}

// ── App state ─────────────────────────────────────────────────────────────
const state = {
  universe: [],
  selected: null, // { name, ticker, slug, sector }
  running: false,
};

// ── Element refs ────────────────────────────────────────────────────────────
const els = {};
function cacheEls() {
  els.input = qs("#company-search");
  els.results = qs("#search-results");
  els.clear = qs("#clear-btn");
  els.run = qs("#run-btn");
  els.chip = qs("#selected-chip");
  els.chipName = qs("#selected-name");
  els.chipTicker = qs("#selected-ticker");
  els.analyzing = qs("#analyzing");
  els.analyzingDetail = qs("#analyzing-detail");
  els.reportRoot = qs("#report-root");
}

// ── Search / type-ahead ─────────────────────────────────────────────────────
function filterUniverse(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return state.universe
    .filter((c) => c.name.toLowerCase().includes(q) || c.ticker.toLowerCase().includes(q))
    .slice(0, 8);
}

function renderResults(query) {
  const matches = filterUniverse(query);
  if (matches.length === 0) {
    closeResults();
    return;
  }
  els.results.innerHTML = matches
    .map(
      (c, i) => `
      <li role="option" data-slug="${escapeHtml(c.slug)}" data-index="${i}" aria-selected="false"
          class="typeahead-item cursor-pointer rounded-xl px-3 py-2 flex items-center justify-between gap-3">
        <span class="min-w-0">
          <span class="block truncate font-medium">${highlightMatch(c.name, query)}</span>
          <span class="block text-xs text-slate-400">${escapeHtml(c.sector)}</span>
        </span>
        <span class="font-mono text-xs text-slate-400 shrink-0">${highlightMatch(c.ticker, query)}</span>
      </li>`
    )
    .join("");
  els.results.classList.remove("hidden");
  els.input.setAttribute("aria-expanded", "true");
}

function closeResults() {
  els.results.classList.add("hidden");
  els.results.innerHTML = "";
  els.input.setAttribute("aria-expanded", "false");
}

function selectCompany(slug) {
  const company = state.universe.find((c) => c.slug === slug);
  if (!company) return;
  state.selected = company;
  els.input.value = company.name;
  els.chipName.textContent = company.name;
  els.chipTicker.textContent = company.ticker;
  show(els.chip, true);
  els.chip.classList.add("flex");
  show(els.clear, true);
  els.run.disabled = false;
  closeResults();
  renderIcons();
}

function clearSelection() {
  state.selected = null;
  els.input.value = "";
  show(els.chip, false);
  els.chip.classList.remove("flex");
  show(els.clear, false);
  els.run.disabled = true;
  closeResults();
  els.input.focus();
}

// ── Run + poll ───────────────────────────────────────────────────────────────
function setAnalyzingDetail(text) {
  if (els.analyzingDetail) els.analyzingDetail.textContent = text;
}

async function runAnalyze() {
  if (!state.selected || state.running) return;
  const company = state.selected;
  state.running = true;
  els.run.disabled = true;
  els.reportRoot.innerHTML = "";
  show(els.analyzing, true);
  setAnalyzingDetail("Dispatching run…");

  try {
    const dispatch = await api.analyze(company.slug);
    setAnalyzingDetail(dispatch.status === "done" ? "Cached — fetching report…" : "Queued — waiting for the Action…");
    const report = await pollReport(company.slug);

    // Step 3 renders this. For now: prove the pipe works.
    console.log("[munshot] report loaded:", report);
    showLoaded(company, report);
  } catch (err) {
    console.error("[munshot] analyze failed:", err);
    showError(company, err);
  } finally {
    show(els.analyzing, false);
    state.running = false;
    els.run.disabled = !state.selected;
  }
}

function showLoaded(company, report) {
  const conviction = report?.next_steps?.conviction ?? "—";
  const quarter = report?.meta?.quarter ?? "—";
  els.reportRoot.innerHTML = `
    <div class="card card-hover fade-in p-6 sm:p-8">
      <div class="flex items-center gap-2 text-emerald-600 font-medium mb-3">
        <i data-lucide="check-circle-2" class="w-5 h-5"></i>
        <span>Report loaded ✓</span>
      </div>
      <h2 class="font-display text-2xl font-bold">${escapeHtml(report?.meta?.company ?? company.name)}</h2>
      <p class="text-slate-500 mt-1">
        <span class="font-mono">${escapeHtml(company.ticker)}</span>
        · ${escapeHtml(quarter)}
        · verdict <span class="font-semibold text-slate-700">${escapeHtml(conviction)}</span>
      </p>
      <p class="text-sm text-slate-400 mt-4">
        Full report renderer arrives in <span class="font-medium text-slate-500">step 3</span>.
        The payload is in the console.
      </p>
    </div>`;
  renderIcons();
}

function showError(company, err) {
  els.reportRoot.innerHTML = `
    <div class="card fade-in p-6 sm:p-8 border border-rose-100">
      <div class="flex items-center gap-2 text-rose-600 font-medium mb-2">
        <i data-lucide="alert-triangle" class="w-5 h-5"></i>
        <span>Couldn't load the report</span>
      </div>
      <p class="text-slate-500 text-sm">${escapeHtml(company.name)} — ${escapeHtml(err.message || String(err))}</p>
    </div>`;
  renderIcons();
}

// ── Events ────────────────────────────────────────────────────────────────────
function wireEvents() {
  const onInput = debounce(() => {
    // Typing invalidates a prior selection until a new pick is made.
    if (state.selected && els.input.value !== state.selected.name) {
      state.selected = null;
      show(els.chip, false);
      els.chip.classList.remove("flex");
      els.run.disabled = true;
    }
    show(els.clear, els.input.value.length > 0);
    renderResults(els.input.value);
  }, 100);

  els.input.addEventListener("input", onInput);

  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeResults();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const first = qs('.typeahead-item[data-index="0"]', els.results);
      if (first) selectCompany(first.getAttribute("data-slug"));
      else if (state.selected) runAnalyze();
    }
  });

  els.results.addEventListener("click", (e) => {
    const item = e.target.closest(".typeahead-item");
    if (item) selectCompany(item.getAttribute("data-slug"));
  });

  els.clear.addEventListener("click", clearSelection);
  els.run.addEventListener("click", runAnalyze);

  // Click-outside closes the dropdown.
  document.addEventListener("click", (e) => {
    if (!els.results.contains(e.target) && e.target !== els.input) closeResults();
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  cacheEls();
  wireEvents();
  renderIcons();
  try {
    state.universe = await api.universe();
    els.input.placeholder = `Search ${state.universe.length} companies — e.g. Navin Fluorine, TCS, SRF…`;
  } catch (err) {
    console.error("[munshot] failed to load universe:", err);
    setAnalyzingDetail("Failed to load company universe.");
  }
}

document.addEventListener("DOMContentLoaded", init);
