// app.js — Concall Deep Dive · MGA (STEP 11 — three-screen product)
// Landing (search + saved-runs library) → Loading (honest staged progress, resume-proof) →
// Report (institutional presentation). The user never lands on a report directly: pick a stock,
// watch progress, arrive at the report. Runs are server-side and survive reload / tab switch.

import { qs, qsa, sleep, debounce, escapeHtml, highlightMatch, renderIcons, show, clamp } from "./ui.js";
import { renderReport, hydrateModel, REPORT_SECTIONS } from "./report.js";
import {
  resolveTarget, pollDecision, STAGES, CHECKLIST_STAGES, stageInfo, sortReports, relativeTime,
  saveInflight, loadInflight, clearInflight,
} from "./analyze.js";

// ── config ──
const MAX_RESULTS = 8;
const SEARCH_DEBOUNCE_MS = 200;
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 300000; // 5 min — generous headroom over the ~1-2 min pipeline

// ── API client ──
const api = {
  async search(q) {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const body = await res.json().catch(() => ({}));
      if (body && body.ok && Array.isArray(body.results)) return body.results;
    } catch { /* fall through to universe */ }
    return null; // signal: use the local fallback
  },
  async universe() { const res = await fetch("/api/universe"); return res.ok ? res.json() : []; },
  async reports() {
    try { const res = await fetch("/api/reports"); const b = await res.json(); return sortReports(b && b.reports); }
    catch { return []; }
  },
  async analyze(target, force = false) {
    const res = await fetch("/api/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: target.name, ticker: target.ticker, force: force === true }),
    });
    let body = {}; try { body = await res.json(); } catch { /* empty */ }
    if (!res.ok && body.status !== "queued" && body.status !== "done") throw new Error(body.error || `/api/analyze → ${res.status}`);
    return body;
  },
  async reportTick(slug) {
    const res = await fetch(`/api/report?slug=${encodeURIComponent(slug)}`);
    let body = {}; try { body = await res.json(); } catch { /* empty */ }
    if (!res.ok && !body.status) throw new Error(body.error || `report fetch failed (HTTP ${res.status})`);
    return pollDecision(body);
  },
};

// ── state ──
const state = { universe: [], selected: null, running: false };
let runToken = 0; // bump to supersede an in-flight run / poll loop

const screens = {};
function cacheScreens() {
  screens.landing = qs("#screen-landing");
  screens.loading = qs("#screen-loading");
  screens.report = qs("#screen-report");
}

// ── router ──
function showScreen(name) {
  ["landing", "loading", "report"].forEach((n) => screens[n].classList.toggle("active", n === name));
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}
function goLanding(push = true) {
  runToken++; state.running = false;
  showScreen("landing");
  if (push && location.hash !== "#/") history.pushState({ screen: "landing" }, "", "#/");
  loadLibrary();
}
window.addEventListener("popstate", () => { runToken++; state.running = false; showScreen("landing"); loadLibrary(); });

// ══════════════════════════════════════════════════════════════════════════════
// SCREEN 1 · LANDING
// ══════════════════════════════════════════════════════════════════════════════
function renderLanding() {
  screens.landing.innerHTML = `
    <div class="fade-in pt-12 sm:pt-16 pb-8 text-center max-w-3xl mx-auto">
      <div class="inline-flex items-center gap-2 rounded-full bg-white ring-1 ring-slate-100 px-3 py-1 text-xs text-slate-500 shadow-sm mb-6">
        <i data-lucide="sparkles" class="w-3.5 h-3.5 text-fuchsia-500"></i> Powered by the full Munshot pipeline
      </div>
      <h1 class="font-display text-4xl sm:text-6xl font-bold tracking-tight leading-[1.05]">
        <span class="brand-gradient">Concall Deep Dive</span>
      </h1>
      <p class="mt-4 text-lg text-slate-500">Institutional-grade earnings-call analysis, one company at a time.</p>
    </div>

    <div class="fade-in max-w-2xl mx-auto">
      <div class="card p-2 sm:p-2.5">
        <div class="relative">
          <div class="flex items-center gap-3 rounded-2xl px-4 py-3.5">
            <i data-lucide="search" class="w-5 h-5 text-slate-400 shrink-0"></i>
            <input id="company-search" type="text" autocomplete="off" role="combobox" aria-expanded="false"
              aria-controls="search-results" aria-autocomplete="list"
              placeholder="Search any listed company — e.g. Reliance, Navin Fluorine, TCS…"
              class="w-full bg-transparent outline-none text-lg placeholder:text-slate-400 font-display" />
            <button id="clear-btn" type="button" aria-label="Clear" class="hidden text-slate-400 hover:text-slate-600"><i data-lucide="x" class="w-5 h-5"></i></button>
          </div>
          <ul id="search-results" role="listbox" class="hidden absolute z-20 mt-2 w-full max-h-80 overflow-auto card p-2"></ul>
        </div>
      </div>
      <div class="mt-4 flex items-center justify-between gap-4 px-1">
        <p id="selected-line" class="text-sm text-slate-400 min-h-[1.25rem]">Pick a stock to begin.</p>
        <button id="run-btn" type="button" disabled class="btn-primary font-semibold px-6 py-3 inline-flex items-center gap-2 shrink-0">
          <i data-lucide="play" class="w-4 h-4"></i> Run Analyze
        </button>
      </div>
    </div>

    <div id="library" class="fade-in max-w-5xl mx-auto mt-14 mb-6"></div>`;
  wireSearch();
  loadLibrary();
  renderIcons();
}

// ── search combobox (Muns via /api/search, universe.json fallback) ──
const search = { open: false, items: [], active: -1, seq: 0 };
let sEls = {};
function wireSearch() {
  sEls = { input: qs("#company-search"), results: qs("#search-results"), clear: qs("#clear-btn"), run: qs("#run-btn"), line: qs("#selected-line") };
  sEls.input.addEventListener("input", () => { onSearchInput(); runSearch(sEls.input.value); });
  sEls.input.addEventListener("focus", () => { if (sEls.input.value.trim()) runSearch(sEls.input.value); });
  sEls.input.addEventListener("keydown", onSearchKey);
  sEls.results.addEventListener("click", (e) => { const it = e.target.closest(".typeahead-item"); if (it) selectItem(Number(it.dataset.index)); });
  sEls.results.addEventListener("mouseover", (e) => { const it = e.target.closest(".typeahead-item"); if (it) { search.active = Number(it.dataset.index); paintActive(); } });
  sEls.clear.addEventListener("click", clearSearch);
  sEls.run.addEventListener("click", () => { if (state.selected) startAnalyze(state.selected, false); });
  document.addEventListener("click", (e) => { if (sEls.results && !sEls.results.contains(e.target) && e.target !== sEls.input) closeList(); });
}
function onSearchInput() {
  show(sEls.clear, sEls.input.value.length > 0);
  if (state.selected && sEls.input.value !== state.selected.name) { state.selected = null; sEls.line.textContent = "Pick a stock to begin."; sEls.run.disabled = true; }
}
const runSearch = debounce(async (raw) => {
  const q = raw.trim();
  if (q.length < 2) { closeList(); return; }
  const seq = ++search.seq;
  let results = await api.search(q);
  if (seq !== search.seq) return; // superseded
  if (results === null) results = universeFallback(q); // Muns unavailable → local
  search.items = results.slice(0, MAX_RESULTS);
  search.active = search.items.length ? 0 : -1;
  renderList(q);
}, SEARCH_DEBOUNCE_MS);

function universeFallback(q) {
  const s = q.toLowerCase();
  return state.universe
    .filter((c) => c.name.toLowerCase().includes(s) || c.ticker.toLowerCase().includes(s))
    .map((c) => ({ ticker: c.ticker, name: c.name, sector: c.sector || null, country: "India" }));
}

function renderList(q) {
  search.open = true;
  sEls.input.setAttribute("aria-expanded", "true");
  if (!search.items.length) {
    sEls.results.innerHTML = `<li class="px-3 py-3 text-sm text-slate-500 flex items-center gap-2"><i data-lucide="search-x" class="w-4 h-4 text-slate-400"></i>No listed companies match “${escapeHtml(q)}”.</li>`;
  } else {
    sEls.results.innerHTML = search.items.map((c, i) => `
      <li role="option" data-index="${i}" aria-selected="false" class="typeahead-item cursor-pointer rounded-xl px-3 py-2.5 flex items-center justify-between gap-3">
        <span class="min-w-0">
          <span class="block truncate font-medium text-slate-800">${highlightMatch(c.name, q)}</span>
          <span class="font-mono text-xs text-slate-400">${highlightMatch(c.ticker, q)}</span>
        </span>
        <span class="text-xs text-slate-400 shrink-0 text-right max-w-[9rem] truncate">${escapeHtml(c.sector || "")}</span>
      </li>`).join("");
  }
  sEls.results.classList.remove("hidden");
  paintActive(); renderIcons();
}
function paintActive() { qsa(".typeahead-item", sEls.results).forEach((r) => { const on = Number(r.dataset.index) === search.active; r.setAttribute("aria-selected", on ? "true" : "false"); if (on) r.scrollIntoView({ block: "nearest" }); }); }
function closeList() { search.open = false; search.active = -1; sEls.results.classList.add("hidden"); sEls.results.innerHTML = ""; sEls.input.setAttribute("aria-expanded", "false"); }
function onSearchKey(e) {
  if (!search.open && e.key === "ArrowDown") { runSearch(sEls.input.value); e.preventDefault(); return; }
  if (e.key === "ArrowDown") { e.preventDefault(); if (search.items.length) { search.active = clamp(search.active + 1, 0, search.items.length - 1); paintActive(); } }
  else if (e.key === "ArrowUp") { e.preventDefault(); if (search.items.length) { search.active = clamp(search.active - 1, 0, search.items.length - 1); paintActive(); } }
  else if (e.key === "Enter") { e.preventDefault(); if (search.open && search.active >= 0 && search.items[search.active]) selectItem(search.active); else if (state.selected) startAnalyze(state.selected, false); }
  else if (e.key === "Escape") closeList();
}
function selectItem(i) {
  const c = search.items[i]; if (!c) return;
  state.selected = { name: c.name, ticker: c.ticker, sector: c.sector };
  sEls.input.value = c.name;
  sEls.line.innerHTML = `Selected <span class="font-medium text-slate-700">${escapeHtml(c.name)}</span> <span class="font-mono text-slate-400">${escapeHtml(c.ticker)}</span>`;
  sEls.run.disabled = false;
  closeList(); renderIcons();
}
function clearSearch() { state.selected = null; sEls.input.value = ""; show(sEls.clear, false); sEls.run.disabled = true; sEls.line.textContent = "Pick a stock to begin."; sEls.input.focus(); closeList(); }

// ── saved-runs library ──
const CONVICTION_CHIP = {
  "Buy-watch": "bg-emerald-50 text-emerald-700 ring-emerald-200",
  "Hold-watch": "bg-amber-50 text-amber-700 ring-amber-200",
  "Avoid-watch": "bg-rose-50 text-rose-700 ring-rose-200",
};
async function loadLibrary() {
  const root = qs("#library"); if (!root) return;
  root.innerHTML = `<div class="flex items-center justify-between mb-4"><h2 class="font-display text-lg font-bold text-slate-800">Saved analyses</h2></div>
    <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">${Array.from({ length: 3 }).map(() => `<div class="card p-5"><div class="h-3 w-2/3 skel mb-3"></div><div class="h-3 w-1/3 skel"></div></div>`).join("")}</div>`;
  const reports = await api.reports();
  if (!qs("#library")) return; // navigated away
  if (!reports.length) {
    root.innerHTML = `
      <h2 class="font-display text-lg font-bold text-slate-800 mb-3">Saved analyses</h2>
      <div class="card p-8 text-center text-slate-500">
        <i data-lucide="folder-open" class="w-8 h-8 mx-auto text-slate-300 mb-2"></i>
        <p class="text-sm">No analyses yet — search a company above and run your first deep dive.</p>
      </div>`;
    renderIcons(); return;
  }
  const cards = reports.map((r) => {
    const chip = CONVICTION_CHIP[r.conviction] || "bg-slate-100 text-slate-500 ring-slate-200";
    return `
      <div class="card card-hover p-5 flex flex-col gap-3 cursor-pointer" data-open="${escapeHtml(r.slug)}" data-name="${escapeHtml(r.company || "")}" data-ticker="${escapeHtml(r.ticker || "")}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="font-semibold text-slate-800 truncate">${escapeHtml(r.company || r.slug)}</p>
            <p class="font-mono text-xs text-slate-400">${escapeHtml(r.ticker || "")}${r.sector ? ` · ${escapeHtml(r.sector)}` : ""}</p>
          </div>
          ${r.conviction ? `<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${chip} shrink-0">${escapeHtml(r.conviction)}</span>` : ""}
        </div>
        <div class="mt-auto flex items-center justify-between text-xs text-slate-400">
          <span>Analyzed ${escapeHtml(relativeTime(r.generated_at))}</span>
          <button type="button" data-rerun="${escapeHtml(r.slug)}" class="inline-flex items-center gap-1 rounded-full px-2 py-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50" aria-label="Re-run"><i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i>Re-run</button>
        </div>
      </div>`;
  }).join("");
  root.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <h2 class="font-display text-lg font-bold text-slate-800">Saved analyses</h2>
      <span class="text-xs text-slate-400">${reports.length} ${reports.length === 1 ? "company" : "companies"} analyzed</span>
    </div>
    <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">${cards}</div>`;
  root.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", (e) => {
    if (e.target.closest("[data-rerun]")) return; // handled below
    openSavedReport(el.dataset.open, { name: el.dataset.name, ticker: el.dataset.ticker });
  }));
  root.querySelectorAll("[data-rerun]").forEach((el) => el.addEventListener("click", (e) => {
    e.stopPropagation();
    const card = el.closest("[data-open]");
    startAnalyze({ name: card.dataset.name, ticker: card.dataset.ticker }, true);
  }));
  renderIcons();
}

async function openSavedReport(slug, meta) {
  showScreen("report");
  screens.report.innerHTML = loadingCardHtml(`Opening ${escapeHtml(meta.name || slug)}…`);
  renderIcons();
  try {
    const decision = await api.reportTick(slug);
    if (decision.action === "done") mountReport(decision.report, meta);
    else if (decision.action === "wait") startAnalyze(meta, false); // cache gone / mid-run → analyze
    else throw new Error(decision.message || "Couldn't open that report.");
  } catch (err) { screens.report.innerHTML = errorCardHtml(meta.name || slug, err.message, () => goLanding()); renderIcons(); }
}

// ══════════════════════════════════════════════════════════════════════════════
// RUN + SCREEN 2 · LOADING
// ══════════════════════════════════════════════════════════════════════════════
const loading = { token: 0, target: null, displayPct: 0, stageKey: "queued", creep: null };

async function startAnalyze(target, force) {
  const t = resolveTarget(target, target && target.name);
  if (!t || state.running) return;
  const token = ++runToken; loading.token = token;
  state.running = true; loading.target = t; loading.displayPct = 0; loading.stageKey = "queued";
  saveInflight({ slug: t.slug, company: t.name, ticker: t.ticker, startedAt: Date.now() });
  history.pushState({ screen: "loading", slug: t.slug }, "", `#/loading/${t.slug}`);
  renderLoading(t);
  try {
    const dispatch = await api.analyze(t, force);
    if (token !== runToken) return;
    if (dispatch.status === "error") return failLoading(t, dispatch.error || "Could not start the analysis.");
    await pollLoop(t, token);
  } catch (err) {
    if (token === runToken) failLoading(t, err.message || String(err));
  }
}

function renderLoading(t) {
  showScreen("loading");
  screens.loading.innerHTML = `
    <div class="fade-in max-w-2xl mx-auto pt-14 pb-10">
      <div class="text-center mb-8">
        <div class="inline-flex items-center gap-2 text-xs text-slate-400 mb-3"><span class="spinner"></span> Analyzing — this usually takes ~1–2 minutes</div>
        <h2 class="font-display text-3xl font-bold text-slate-800">${escapeHtml(t.name)}</h2>
        <p class="font-mono text-sm text-slate-400 mt-1">${escapeHtml(t.ticker || "")}</p>
      </div>
      <div class="card p-6 sm:p-8">
        <div class="flex items-center justify-between text-sm mb-2">
          <span id="load-label" class="text-slate-600 font-medium">Starting the analysis…</span>
          <span id="load-pct" class="font-mono text-slate-400">0%</span>
        </div>
        <div class="progress-track"><div id="load-bar" class="progress-fill" style="width:0%"></div></div>
        <ul id="load-steps" class="mt-6 space-y-3">${CHECKLIST_STAGES.map((s) => stepRow(s)).join("")}</ul>
        <div class="mt-6 text-center">
          <button id="load-cancel" type="button" class="text-xs text-slate-400 hover:text-slate-600">Cancel and go back</button>
        </div>
      </div>
      <p class="text-center text-xs text-slate-400 mt-4">You can switch tabs or reload — the analysis keeps running and this page will catch up.</p>
    </div>`;
  qs("#load-cancel").addEventListener("click", () => { clearInflight(); goLanding(); });
  startCreep();
  paintProgress();
  renderIcons();
}
function stepRow(s) {
  return `<li data-stage="${s.key}" class="flex items-center gap-3 text-sm text-slate-400">
    <span class="stage-dot inline-flex items-center justify-center w-5 h-5 rounded-full ring-1 ring-slate-200 text-slate-300 shrink-0"><i data-lucide="circle" class="w-2.5 h-2.5"></i></span>
    <span class="stage-text">${escapeHtml(s.label)}</span>
  </li>`;
}

function startCreep() {
  stopCreep();
  loading.creep = setInterval(() => {
    const i = stageInfo(loading.stageKey).index;
    const ceil = (STAGES[i + 1] || STAGES[STAGES.length - 1]).pct - 1;
    if (loading.displayPct < ceil) { loading.displayPct = Math.min(ceil, loading.displayPct + 0.4); paintProgress(); }
  }, 700);
}
function stopCreep() { if (loading.creep) { clearInterval(loading.creep); loading.creep = null; } }

function setStage(stageKey) {
  const info = stageInfo(stageKey);
  loading.stageKey = info.key;
  loading.displayPct = Math.max(loading.displayPct, info.pct); // monotonic; jump to the stage floor
  paintProgress();
}
function paintProgress() {
  const bar = qs("#load-bar"), pct = qs("#load-pct"), label = qs("#load-label");
  if (!bar) return;
  const p = Math.round(loading.displayPct);
  bar.style.width = `${p}%`; if (pct) pct.textContent = `${p}%`;
  if (label) label.textContent = stageInfo(loading.stageKey).label;
  const curIdx = stageInfo(loading.stageKey).index;
  qsa("#load-steps [data-stage]").forEach((li) => {
    const idx = STAGES.findIndex((s) => s.key === li.dataset.stage);
    const dot = li.querySelector(".stage-dot");
    li.classList.remove("stage-active");
    if (idx < curIdx) { li.className = "flex items-center gap-3 text-sm text-slate-600"; dot.className = "stage-dot inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 text-white shrink-0"; dot.innerHTML = `<i data-lucide="check" class="w-3 h-3"></i>`; }
    else if (idx === curIdx) { li.className = "flex items-center gap-3 text-sm text-slate-800 font-medium stage-active"; dot.className = "stage-dot inline-flex items-center justify-center w-5 h-5 rounded-full brand-bg text-white shrink-0"; dot.innerHTML = `<i data-lucide="loader" class="w-3 h-3"></i>`; }
    else { li.className = "flex items-center gap-3 text-sm text-slate-400"; dot.className = "stage-dot inline-flex items-center justify-center w-5 h-5 rounded-full ring-1 ring-slate-200 text-slate-300 shrink-0"; dot.innerHTML = `<i data-lucide="circle" class="w-2.5 h-2.5"></i>`; }
  });
  renderIcons();
}

async function pollLoop(t, token) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const tick = async () => {
    if (token !== runToken) return { stop: true };
    const decision = await api.reportTick(t.slug);
    if (token !== runToken) return { stop: true };
    if (decision.action === "done") { finishLoading(t, decision.report, token); return { stop: true }; }
    if (decision.action === "error") { failLoading(t, decision.message); return { stop: true }; }
    if (decision.stage) setStage(decision.stage);
    return { stop: false };
  };
  // immediate first tick, then interval; re-poll on refocus so a backgrounded tab catches up.
  const onFocus = () => { if (token === runToken && document.visibilityState === "visible") tick(); };
  document.addEventListener("visibilitychange", onFocus);
  try {
    let r = await tick();
    while (!r.stop && Date.now() < deadline) { await sleep(POLL_INTERVAL_MS); r = await tick(); }
    if (!r.stop && token === runToken) failLoading(t, "This is taking longer than expected — the run may still finish. Try again in a minute.", true);
  } finally { document.removeEventListener("visibilitychange", onFocus); }
}

function finishLoading(t, report, token) {
  if (token !== runToken) return;
  stopCreep(); state.running = false; clearInflight();
  loading.displayPct = 100; loading.stageKey = "done"; paintProgress();
  mountReport(report, t);
}
function failLoading(t, message, timeout = false) {
  stopCreep(); state.running = false; if (!timeout) clearInflight();
  showScreen("loading");
  screens.loading.innerHTML = errorCardHtml(t.name, message, () => startAnalyze(t, true), () => goLanding());
  renderIcons();
}

// ══════════════════════════════════════════════════════════════════════════════
// SCREEN 3 · REPORT
// ══════════════════════════════════════════════════════════════════════════════
function mountReport(report, meta) {
  runToken++; state.running = false;
  showScreen("report");
  history.replaceState({ screen: "report", slug: report?.meta?.slug }, "", `#/report/${report?.meta?.slug || meta.ticker || ""}`);
  const gen = report?.meta?.generated_at ? `Generated ${relativeTime(report.meta.generated_at)}` : "Live report";
  const nav = REPORT_SECTIONS.map((s) => `<a href="#${s.id}" data-nav="${s.id}" class="whitespace-nowrap text-sm font-medium pb-2 px-1">${escapeHtml(s.label)}</a>`).join("");
  screens.report.innerHTML = `
    <div class="fade-in py-8">
      <div class="flex items-center justify-between gap-3 mb-4">
        <button id="back-btn" type="button" class="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"><i data-lucide="arrow-left" class="w-4 h-4"></i>Library</button>
        <div class="flex items-center gap-3">
          <span class="text-xs text-slate-400">${gen}</span>
          <button id="regen-btn" type="button" class="inline-flex items-center gap-1.5 rounded-full ring-1 ring-inset ring-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50"><i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i>Regenerate</button>
        </div>
      </div>
      <div class="sticky top-14 z-20 -mx-6 px-6 py-1 bg-[#FBFAFF]/85 backdrop-blur border-b border-slate-100 mb-6 overflow-x-auto">
        <nav class="report-nav flex items-center gap-5">${nav}</nav>
      </div>
      <div id="report-body">${renderReport(report)}</div>
    </div>`;
  hydrateModel(report, qs("#report-body"));
  qs("#back-btn").addEventListener("click", () => goLanding());
  qs("#regen-btn").addEventListener("click", () => startAnalyze({ name: report?.meta?.company || meta.name, ticker: report?.meta?.ticker || meta.ticker }, true));
  qsa(".report-nav a").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); const el = qs(`#${a.dataset.nav}`); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }));
  wireScrollSpy();
  renderIcons();
}

function wireScrollSpy() {
  const links = new Map(qsa(".report-nav a").map((a) => [a.dataset.nav, a]));
  const setActive = (id) => links.forEach((a, key) => a.classList.toggle("active", key === id));
  const targets = REPORT_SECTIONS.map((s) => qs(`#${s.id}`)).filter(Boolean);
  if (!("IntersectionObserver" in window) || !targets.length) return;
  const obs = new IntersectionObserver((entries) => {
    const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible[0]) setActive(visible[0].target.id);
  }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 });
  targets.forEach((el) => obs.observe(el));
}

// ── shared UI bits ──
function loadingCardHtml(label) {
  return `<div class="fade-in max-w-2xl mx-auto py-16"><div class="card p-8 flex items-center gap-3"><span class="spinner"></span><span class="text-slate-600 font-medium">${label}</span></div></div>`;
}
function errorCardHtml(name, message, onRetry, onBack) {
  const id = `err-${Math.abs((name || "").length + (message || "").length)}`;
  queueMicrotask(() => {
    const r = qs("#retry-btn"); if (r && onRetry) r.addEventListener("click", () => onRetry());
    const b = qs("#error-back"); if (b && onBack) b.addEventListener("click", () => onBack());
  });
  return `
    <div class="fade-in max-w-2xl mx-auto py-14" id="${id}">
      <div class="card p-8 text-center border border-rose-100">
        <i data-lucide="alert-triangle" class="w-8 h-8 mx-auto text-rose-400 mb-3"></i>
        <h3 class="font-display font-bold text-lg text-slate-800 mb-1">Couldn't complete the analysis</h3>
        <p class="text-sm text-slate-500 mb-1">${escapeHtml(name || "")}</p>
        <p class="text-sm text-slate-500 max-w-md mx-auto">${escapeHtml(message || "Something went wrong.")}</p>
        <div class="mt-6 flex items-center justify-center gap-3">
          <button id="retry-btn" type="button" class="btn-primary font-semibold px-5 py-2.5 inline-flex items-center gap-2"><i data-lucide="rotate-ccw" class="w-4 h-4"></i>Try again</button>
          <button id="error-back" type="button" class="rounded-full ring-1 ring-inset ring-slate-200 text-slate-600 px-5 py-2.5 text-sm font-semibold hover:bg-slate-50">Back to library</button>
        </div>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════════
async function resumeIfInFlight() {
  const run = loadInflight();
  if (!run || !run.slug) return false;
  const t = { name: run.company || run.slug, ticker: run.ticker || "", slug: run.slug };
  try {
    const decision = await api.reportTick(run.slug);
    if (decision.action === "done") { clearInflight(); mountReport(decision.report, t); return true; }
    if (decision.action === "error") { clearInflight(); return false; }
    // still running → resume the loading screen + poll
    const token = ++runToken; loading.token = token; state.running = true; loading.target = t; loading.displayPct = 0; loading.stageKey = decision.stage || "queued";
    renderLoading(t); if (decision.stage) setStage(decision.stage);
    pollLoop(t, token);
    return true;
  } catch { clearInflight(); return false; }
}

async function init() {
  cacheScreens();
  renderLanding();
  qs("#brand-home").addEventListener("click", () => goLanding());
  api.universe().then((u) => { state.universe = Array.isArray(u) ? u : []; }).catch(() => {});
  const resumed = await resumeIfInFlight();
  if (!resumed) showScreen("landing");
}
document.addEventListener("DOMContentLoaded", init);
