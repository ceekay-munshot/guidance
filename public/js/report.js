// report.js — report renderer (STEPS 3–5).
// renderReport(report) → HTML string. Renders strictly from report.schema.json's shape.
// ALL rendered strings are escaped — the data will be LLM-generated later, so untrusted.
//
// Built: header, Key Takeaways, B about, C.1 guidance, C.2 themes, C.3 expansion flags,
// C.4 thesis-triggers [Step 3]; C.5 classification, C.6 risks, C.7 management tone,
// C.8 analyst tone, D thesis/anti-thesis, G conviction [Step 4]; E editable financial
// model + F live valuation [Step 5]. The whole client-facing report is now complete.
//
// Step 5 is interactive: renderReport() emits the initial (seed) state, then app.js calls
// hydrateModel(report, rootEl) to wire the assumption inputs. computeModel(report, edits)
// is the PURE, deterministic recompute (unit-tested) — it keys off each row's `key`+`unit`,
// never the display label.
//
// Reusable helpers: sourceTag(), stancePill(), toneBadge(), chip(), sectionCard(), table().

import { escapeHtml } from "./ui.js";
import { buildSourceLink, collectWebSources, hostOf } from "./provenance.js";

// ── formatting ──────────────────────────────────────────────────────────────
const num = (v) => (typeof v === "number" && isFinite(v) ? v.toLocaleString("en-IN") : null);
const rupees = (v) => (num(v) !== null ? `₹${num(v)}` : "—");
const rupeesCr = (v) => (num(v) !== null ? `₹${num(v)}cr` : "—");
const dash = (s) => (s == null || s === "" ? "—" : String(s));

// ── reusable chips ──────────────────────────────────────────────────────────
const SRC_STYLES = {
  Transcript: "bg-violet-50 text-violet-700 ring-violet-200",
  PPT: "bg-blue-50 text-blue-700 ring-blue-200",
  Web: "bg-amber-50 text-amber-700 ring-amber-200",
  "Est.": "bg-slate-100 text-slate-600 ring-slate-200",
};
/** Source provenance chip: [Transcript] [PPT] [Web] [Est.]. Reused across all sections. */
export function sourceTag(source) {
  if (!source) return "";
  const cls = SRC_STYLES[source] || "bg-slate-100 text-slate-600 ring-slate-200";
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium font-mono whitespace-nowrap ring-1 ring-inset ${cls}">${escapeHtml(source)}</span>`;
}

/**
 * Interactive source chip for a specific fact — the traceability primitive.
 *   • Opens the source document (transcript / deck / web page). For an HTML page the link is a
 *     Chromium scroll-to-text deep link that highlights the verbatim quote; for a PDF it just opens
 *     (browsers can't deep-link inside a PDF).
 *   • When a verbatim `quote` exists, a small ⌕ button copies it so the reader can Ctrl+F in the
 *     source (wired by hydrateProvenance). No linkable source (Est.) → the plain chip.
 * `fact` may carry {source, quote|anchor, source_url}; `meta` supplies the doc URLs.
 */
export function sourceRef(fact, meta) {
  const label = (fact && fact.source) || "";
  if (!label) return "";
  const cls = SRC_STYLES[label] || "bg-slate-100 text-slate-600 ring-slate-200";
  const chip = `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium font-mono whitespace-nowrap ring-1 ring-inset ${cls}`;
  const link = buildSourceLink(fact, meta);
  if (link.kind === "none") return `<span class="${chip}">${escapeHtml(label)}</span>`;
  const q = link.quote ? escapeHtml(link.quote) : "";
  const hint = link.kind === "pdf" ? "Opens the source PDF — Ctrl+F the quote" : "Opens the source and highlights the quote";
  const copy = link.quote
    ? `<button type="button" class="src-copy inline-flex items-center justify-center w-4 h-4 rounded-full ring-1 ring-inset ring-slate-200 text-slate-400 hover:text-indigo-600 hover:ring-indigo-200" data-quote="${q}" aria-label="Copy quote to search in the source" title="Copy the quote, then Ctrl+F in the source"><i data-lucide="search" class="w-2.5 h-2.5"></i></button>`
    : "";
  return `<span class="inline-flex items-center gap-1">`
    + `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer" class="${chip} hover:underline" title="${q || escapeHtml(hint)}">${escapeHtml(label)}<i data-lucide="external-link" class="w-2.5 h-2.5"></i></a>`
    + copy
    + `</span>`;
}

const STANCE_STYLES = {
  Positive: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  Negative: "bg-rose-50 text-rose-700 ring-rose-200",
  Neutral: "bg-slate-100 text-slate-600 ring-slate-200",
};
/** Stance pill for themes: Positive=green, Negative=red, Neutral=slate. Reused in Step 4. */
export function stancePill(stance) {
  const cls = STANCE_STYLES[stance] || STANCE_STYLES.Neutral;
  return `<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}">${escapeHtml(dash(stance))}</span>`;
}

/** Generic indigo chip for tags/labels. */
export function chip(text) {
  return `<span class="inline-flex items-center rounded-full bg-indigo-50 text-indigo-700 px-3 py-1 text-sm font-medium">${escapeHtml(dash(text))}</span>`;
}

// ── layout scaffolding ──────────────────────────────────────────────────────
/** A titled report section as a .card. `bodyHtml` is trusted (built here); title is escaped. */
function sectionCard(title, bodyHtml) {
  return `
  <section class="card fade-in p-6 sm:p-8 mb-6">
    <h3 class="font-display text-lg font-bold mb-4 flex items-center gap-2">
      <span class="inline-block h-4 w-1 rounded-full" style="background:linear-gradient(180deg,#6366F1,#EC4899)"></span>
      ${escapeHtml(title)}
    </h3>
    ${bodyHtml}
  </section>`;
}

/**
 * Institutional table (styled via `.r-table` in index.html). `headers` are escaped; `rows` are
 * arrays of pre-built HTML cells. `aligns[i] === "num"` right-aligns + monospaces that column
 * (numbers). Wrapped in an overflow-x container so the page never scrolls sideways on mobile.
 */
function table(headers, rows, aligns = []) {
  const numAt = (i) => (aligns[i] === "num" ? " num" : "");
  const head = headers.map((h, i) => `<th class="${numAt(i).trim()}">${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map((cells) => `<tr>${cells.map((c, i) => `<td class="${numAt(i).trim()}">${c}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="overflow-x-auto"><table class="r-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const empty = (msg = "—") => `<p class="text-sm text-slate-400">${escapeHtml(msg)}</p>`;

// ── 1 · header strip ────────────────────────────────────────────────────────
function headerStrip(report) {
  const m = report.meta ?? {};
  const i = m.inputs ?? {};
  const banner =
    m.transcript_available === false
      ? `<div class="mb-4 rounded-xl bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-300 px-4 py-2 text-sm font-bold font-mono">[PPT-ONLY — NO TRANSCRIPT]</div>`
      : "";
  const unconfirmed =
    m.quarter_confirmed === false
      ? `<span class="text-xs text-amber-600 font-medium">(quarter unconfirmed)</span>`
      : "";
  const concall = m.sources?.concall_date ? `<span>· concall ${escapeHtml(m.sources.concall_date)}</span>` : "";
  const stat = (label, val) =>
    `<span class="text-slate-500">${escapeHtml(label)} <span class="font-mono text-slate-700">${val}</span></span>`;
  return `
  <section class="fade-in mb-6">
    ${banner}
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 class="font-display text-3xl font-bold">${escapeHtml(dash(m.company))}</h2>
      <span class="font-mono text-slate-400">${escapeHtml(dash(m.ticker))}</span>
    </div>
    <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
      <span class="font-semibold text-slate-700">${escapeHtml(dash(m.quarter))}</span> ${unconfirmed}
      ${concall}
    </div>
    <div class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
      ${stat("CMP", rupees(i.cmp))}
      ${stat("Mkt cap", rupeesCr(i.market_cap_cr))}
      ${stat("Net debt", rupeesCr(i.net_debt_cr))}
    </div>
  </section>`;
}

// ── 2 · Key Takeaways (hero) ────────────────────────────────────────────────
function keyTakeaways(report) {
  const items = Array.isArray(report.key_takeaways) ? report.key_takeaways : [];
  if (!items.length) return "";
  const lis = items
    .map(
      (t) => `
      <li class="flex gap-3">
        <span class="mt-2 h-1.5 w-1.5 shrink-0 rounded-full" style="background:linear-gradient(100deg,#6366F1,#EC4899)"></span>
        <span class="text-slate-700 leading-relaxed">${escapeHtml(t)}</span>
      </li>`
    )
    .join("");
  return `
  <section class="card card-hover fade-in p-6 sm:p-8 mb-8 relative overflow-hidden">
    <div class="absolute inset-x-0 top-0 h-1" style="background:linear-gradient(100deg,#6366F1,#A855F7 45%,#EC4899 80%)"></div>
    <div class="flex items-center gap-2 mb-4">
      <i data-lucide="sparkles" class="w-5 h-5 text-fuchsia-500"></i>
      <h2 class="font-display text-xl font-bold brand-gradient">Key Takeaways</h2>
    </div>
    <ul class="space-y-3">${lis}</ul>
  </section>`;
}

// ── 3 · Section B — About ───────────────────────────────────────────────────
function aboutSection(report) {
  const a = report.about ?? {};
  const sectorChips = [a.sector, a.sub_sector].filter((x) => x != null && x !== "").map(chip).join(" ") || chip("—");

  const products = Array.isArray(a.products) ? a.products : [];
  const productList = products.length
    ? `<ul class="list-disc list-inside space-y-1 text-sm text-slate-700">${products.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`
    : empty();

  const segments = Array.isArray(a.segments) ? a.segments : [];
  const segChips = segments.length ? `<div class="flex flex-wrap gap-2">${segments.map(chip).join(" ")}</div>` : empty();

  // revenue_mix as labeled horizontal bars
  const mix = Array.isArray(a.revenue_mix) ? a.revenue_mix : [];
  const mixBars = mix.length
    ? mix
        .map((row) => {
          const isNum = typeof row.pct === "number" && isFinite(row.pct);
          const w = isNum ? Math.max(0, Math.min(100, row.pct)) : 0;
          const label = isNum ? `${row.pct}%` : escapeHtml(dash(row.pct));
          return `
            <div>
              <div class="flex justify-between text-sm mb-1">
                <span class="text-slate-600">${escapeHtml(dash(row.segment))}</span>
                <span class="font-mono text-slate-500">${label}</span>
              </div>
              <div class="h-2 rounded-full bg-slate-100 overflow-hidden">
                <div class="h-full rounded-full" style="width:${w}%;background:linear-gradient(100deg,#6366F1,#A855F7 45%,#EC4899 80%)"></div>
              </div>
            </div>`;
        })
        .join("")
    : empty();

  // margin_by_segment — print non-numeric values (e.g. "not disclosed") verbatim; never invent.
  const mbs = Array.isArray(a.margin_by_segment) ? a.margin_by_segment : [];
  const mbsBody = mbs.length
    ? table(
        ["Segment", "EBITDA margin"],
        mbs.map((row) => {
          const v = row.ebitda_margin;
          const cell = typeof v === "number" && isFinite(v) ? `${v}%` : escapeHtml(dash(v == null ? "not disclosed" : v));
          return [escapeHtml(dash(row.segment)), cell];
        })
      )
    : empty();

  const notReported =
    a.segment_reported === false
      ? `<p class="text-xs text-amber-600 mb-1">Company does not report segment splits — the mix &amp; margins below are estimated.</p>`
      : "";

  const body = `
    <div class="space-y-5">
      <div class="flex flex-wrap gap-2">${sectorChips}</div>
      <div><h4 class="text-sm font-semibold text-slate-600 mb-2">Products</h4>${productList}</div>
      <div><h4 class="text-sm font-semibold text-slate-600 mb-2">Segments</h4>${segChips}</div>
      ${notReported}
      <div class="grid sm:grid-cols-2 gap-6">
        <div><h4 class="text-sm font-semibold text-slate-600 mb-3">Revenue mix</h4><div class="space-y-3">${mixBars}</div></div>
        <div><h4 class="text-sm font-semibold text-slate-600 mb-3">Margin by segment</h4>${mbsBody}</div>
      </div>
    </div>`;
  return sectionCard("B · About the company", body);
}

// ── 4 · C.1 Guidance ────────────────────────────────────────────────────────
function typeChip(type) {
  if (type === "hard") {
    return `<span class="inline-flex items-center rounded-full bg-indigo-600 text-white px-2.5 py-0.5 text-[11px] font-semibold">hard</span>`;
  }
  return `<span class="inline-flex items-center rounded-full ring-1 ring-inset ring-indigo-300 text-indigo-600 px-2.5 py-0.5 text-[11px] font-semibold">${escapeHtml(dash(type))}</span>`;
}
function guidanceSection(report) {
  const g = report.concall?.guidance ?? [];
  const body = g.length
    ? table(
        ["Metric", "Horizon", "Statement", "Type", "Source"],
        g.map((x) => [
          `<span class="font-medium text-slate-800">${escapeHtml(dash(x.metric))}</span>${x.value ? `<div class="text-xs text-slate-400 font-mono">${escapeHtml(x.value)}</div>` : ""}`,
          escapeHtml(dash(x.horizon)),
          escapeHtml(dash(x.statement)),
          typeChip(x.type),
          sourceRef(x, report.meta) || "—",
        ])
      )
    : empty("No guidance captured.");
  return sectionCard("C.1 · Guidance", body);
}

// ── 5 · C.2 Sector / theme commentary ───────────────────────────────────────
function themesSection(report) {
  const c = report.concall ?? {};
  const themes = Array.isArray(c.themes) ? c.themes : [];
  const cards = themes.length
    ? themes
        .map(
          (t) => `
          <div class="rounded-xl border border-slate-100 p-4">
            <div class="flex items-center justify-between gap-3 mb-2">
              <span class="font-semibold text-slate-800">${escapeHtml(dash(t.theme))}</span>
              <div class="flex items-center gap-2 shrink-0">${stancePill(t.stance)}${sourceRef(t, report.meta)}</div>
            </div>
            <p class="text-sm text-slate-600 leading-relaxed">${escapeHtml(dash(t.evidence))}</p>
          </div>`
        )
        .join("")
    : empty();
  const toneShift = c.tone_shift_vs_last_quarter
    ? `<div class="mb-4 rounded-xl bg-slate-50 px-4 py-3 text-sm">
         <span class="font-semibold text-slate-600">Tone shift vs last quarter: </span>
         <span class="text-slate-700">${escapeHtml(c.tone_shift_vs_last_quarter)}</span>
       </div>`
    : "";
  return sectionCard("C.2 · Sector &amp; theme commentary", `${toneShift}<div class="space-y-3">${cards}</div>`);
}

// ── 6 · C.3 Expansion flags ─────────────────────────────────────────────────
function deltaCell(d) {
  if (d == null || d === "") return `<span class="text-slate-400">—</span>`;
  const s = String(d).trim();
  const cls = s.startsWith("-") ? "text-rose-600" : s.startsWith("+") ? "text-emerald-600" : "text-slate-700";
  return `<span class="font-mono font-medium ${cls}">${escapeHtml(s)}</span>`;
}
function expansionSection(report) {
  const flags = report.concall?.expansion_flags ?? [];
  const body = flags.length
    ? table(
        ["Metric", "YoY Δ", "QoQ Δ", "Driver"],
        flags.map((f) => [
          `<span class="font-medium text-slate-800">${escapeHtml(dash(f.metric))}</span>`,
          deltaCell(f.yoy_delta),
          deltaCell(f.qoq_delta),
          escapeHtml(dash(f.driver)),
        ])
      )
    : empty();
  return sectionCard("C.3 · Margin / revenue expansion flags", body);
}

// ── 7 · C.4 Thesis-trigger checklist ────────────────────────────────────────
function flagBadge(flag) {
  const map = {
    Yes: ["check", "bg-emerald-50 text-emerald-700 ring-emerald-200"],
    Partial: ["minus", "bg-amber-50 text-amber-700 ring-amber-200"],
    No: ["x", "bg-slate-100 text-slate-500 ring-slate-200"],
  };
  const [icon, cls] = map[flag] || map.No;
  return `<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}"><i data-lucide="${icon}" class="w-3.5 h-3.5"></i>${escapeHtml(dash(flag))}</span>`;
}
function thesisTriggersSection(report) {
  const trg = report.concall?.thesis_triggers ?? [];
  const body = trg.length
    ? `<ul>${trg
        .map(
          (t) => `
          <li class="flex items-start gap-3 py-3 border-t border-slate-100 first:border-t-0 first:pt-0">
            <div class="shrink-0 mt-0.5">${flagBadge(t.flag)}</div>
            <div>
              <div class="font-medium text-slate-800">${escapeHtml(dash(t.trigger))}</div>
              <div class="text-sm text-slate-600">${escapeHtml(dash(t.evidence))}</div>
            </div>
          </li>`
        )
        .join("")}</ul>`
    : empty();
  return sectionCard("C.4 · Thesis-trigger checklist", body);
}

// ── 8 · C.5 Classification (boxed, distinct — client scans this first) ───────
function classificationSection(report) {
  const tags = report.concall?.classification ?? [];
  const body = tags.length
    ? `<div class="space-y-3">${tags
        .map(
          (t) => `
          <div class="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4">
            <span class="inline-flex items-center rounded-full bg-indigo-600 text-white px-3 py-1 text-sm font-bold shrink-0 self-start">${escapeHtml(dash(t.tag))}</span>
            <span class="text-sm text-slate-600">${escapeHtml(dash(t.justification))}</span>
          </div>`
        )
        .join("")}</div>`
    : empty("No classification tags.");
  // Deliberately heavier than the plain .card tables: ring, tinted gradient, left accent.
  return `
  <section class="fade-in mb-6 rounded-3xl p-6 sm:p-8 ring-2 ring-indigo-100 relative overflow-hidden" style="background:linear-gradient(180deg,#faf9ff,#f5f3ff)">
    <div class="absolute inset-y-0 left-0 w-1.5" style="background:linear-gradient(180deg,#6366F1,#EC4899)"></div>
    <h3 class="font-display text-lg font-bold flex items-center gap-2">
      <i data-lucide="tags" class="w-5 h-5 text-indigo-600"></i>C.5 · Classification
    </h3>
    <p class="text-xs text-slate-400 mb-4">How this quarter reads at a glance.</p>
    ${body}
  </section>`;
}

// ── 9 · C.6 Risks ────────────────────────────────────────────────────────────
function risksSection(report) {
  const risks = report.concall?.risks ?? [];
  const body = risks.length
    ? table(
        ["Risk", "Type", "Source"],
        risks.map((r) => [escapeHtml(dash(r.risk)), `<span class="text-slate-600">${escapeHtml(dash(r.type))}</span>`, sourceRef(r, report.meta) || "—"])
      )
    : `<div class="flex items-center gap-2 text-sm text-slate-400"><i data-lucide="shield-check" class="w-4 h-4 text-emerald-500"></i>No material risks surfaced.</div>`;
  return sectionCard("C.6 · Risks", body);
}

// ── 10 · C.7 Management tone ─────────────────────────────────────────────────
const TONE_STYLES = {
  Confident: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  Neutral: "bg-slate-100 text-slate-600 ring-slate-200",
  Defensive: "bg-amber-50 text-amber-700 ring-amber-200",
};
/** Management-tone badge: Confident=green, Neutral=slate, Defensive=amber. Sibling of stancePill(). */
export function toneBadge(tone) {
  const cls = TONE_STYLES[tone] || TONE_STYLES.Neutral;
  return `<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}">${escapeHtml(dash(tone))}</span>`;
}
function managementToneSection(report) {
  const tones = report.concall?.management_tone ?? [];
  const body = tones.length
    ? `<div class="space-y-3">${tones
        .map(
          (t) => `
          <div class="rounded-xl border border-slate-100 p-4">
            <div class="flex items-center justify-between gap-3 mb-2">
              <span class="font-semibold text-slate-800">${escapeHtml(dash(t.theme))}</span>
              <div class="flex items-center gap-2 shrink-0">${toneBadge(t.tone)}${sourceRef({ source: "Transcript", quote: t.anchor }, report.meta)}</div>
            </div>
            <p class="text-sm text-slate-500 italic border-l-2 border-slate-200 pl-3">${escapeHtml(dash(t.anchor))}</p>
          </div>`
        )
        .join("")}</div>`
    : empty();
  return sectionCard("C.7 · Management tone", body);
}

// ── 11 · C.8 Analyst tone ────────────────────────────────────────────────────
const TENOR_STYLES = {
  skeptical: "bg-rose-50 text-rose-700 ring-rose-200",
  constructive: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  perfunctory: "bg-slate-100 text-slate-600 ring-slate-200",
};
function tenorBadge(tenor) {
  const cls = TENOR_STYLES[tenor] || TENOR_STYLES.perfunctory;
  return `<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}">${escapeHtml(dash(tenor))}</span>`;
}
function analystToneSection(report) {
  const at = report.concall?.analyst_tone ?? {};
  const hot = Array.isArray(at.hot_themes) ? at.hot_themes : [];
  const chips = hot.length ? `<div class="flex flex-wrap gap-2">${hot.map(chip).join(" ")}</div>` : empty();
  const body = `
    <div class="grid sm:grid-cols-[1fr_auto] gap-5 items-start">
      <div>
        <h4 class="text-sm font-semibold text-slate-600 mb-2">Hot themes <span class="font-normal text-slate-400">(≥2 follow-ups)</span></h4>
        ${chips}
      </div>
      <div>
        <h4 class="text-sm font-semibold text-slate-600 mb-2">Q&amp;A tenor</h4>
        ${tenorBadge(at.qa_tenor)}
      </div>
    </div>`;
  return sectionCard("C.8 · Analyst tone", body);
}

// ── 12 · D Thesis / Anti-thesis (paired claim ↔ falsifier) ───────────────────
function pointCard(item, accent, meta) {
  const dot = accent === "thesis" ? "#10b981" : "#f43f5e";
  return `
    <div class="rounded-xl border border-slate-100 bg-white/60 p-4">
      <div class="flex items-start gap-2">
        <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style="background:${dot}"></span>
        <div class="min-w-0">
          <p class="text-sm text-slate-800 font-medium">${escapeHtml(dash(item.point))}</p>
          <p class="text-xs text-slate-400 mt-1.5"><span class="font-semibold">Proven wrong if:</span> ${escapeHtml(dash(item.falsifier))}</p>
          <div class="mt-2">${sourceRef(item, meta)}</div>
        </div>
      </div>
    </div>`;
}
function thesisAntiThesisSection(report) {
  const thesis = Array.isArray(report.thesis) ? report.thesis : [];
  const anti = Array.isArray(report.anti_thesis) ? report.anti_thesis : [];
  const col = (title, items, accent, icon, ring, txt) => `
    <div class="rounded-2xl ${ring} p-4 sm:p-5">
      <h4 class="font-display font-bold mb-3 flex items-center gap-2 ${txt}">
        <i data-lucide="${icon}" class="w-4 h-4"></i>${escapeHtml(title)}
      </h4>
      <div class="space-y-3">${items.length ? items.map((x) => pointCard(x, accent, report.meta)).join("") : empty()}</div>
    </div>`;
  const body = `
    <div class="grid md:grid-cols-2 gap-4">
      ${col("Thesis", thesis, "thesis", "trending-up", "ring-1 ring-inset ring-emerald-100 bg-emerald-50/40", "text-emerald-700")}
      ${col("Anti-thesis", anti, "anti", "trending-down", "ring-1 ring-inset ring-rose-100 bg-rose-50/40", "text-rose-700")}
    </div>`;
  return sectionCard("D · Thesis vs Anti-thesis", body);
}

// ── 13 · G Conviction (boxed, distinct — client scans this first) ────────────
const CONVICTION_STYLES = {
  "Buy-watch": { ring: "ring-emerald-300", bg: "linear-gradient(180deg,#f0fdf4,#ecfdf5)", text: "text-emerald-700", icon: "trending-up" },
  "Hold-watch": { ring: "ring-amber-300", bg: "linear-gradient(180deg,#fffbeb,#fefce8)", text: "text-amber-700", icon: "minus-circle" },
  "Avoid-watch": { ring: "ring-rose-300", bg: "linear-gradient(180deg,#fff1f2,#fef2f2)", text: "text-rose-700", icon: "trending-down" },
};
function convictionSection(report) {
  const ns = report.next_steps ?? {};
  const v = ns.conviction;
  const s = CONVICTION_STYLES[v] || { ring: "ring-slate-200", bg: "#ffffff", text: "text-slate-700", icon: "help-circle" };
  const monitor = Array.isArray(ns.monitorables) ? ns.monitorables : [];
  const triggers = Array.isArray(ns.rerating_triggers) ? ns.rerating_triggers : [];
  const list = (title, items, icon) => `
    <div>
      <h4 class="text-sm font-semibold text-slate-600 mb-2 flex items-center gap-1.5"><i data-lucide="${icon}" class="w-4 h-4 text-slate-400"></i>${escapeHtml(title)}</h4>
      ${items.length ? `<ul class="list-disc list-inside space-y-1 text-sm text-slate-600">${items.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : empty()}
    </div>`;
  return `
  <section class="fade-in mb-6 rounded-3xl p-6 sm:p-8 ring-2 ${s.ring}" style="background:${s.bg}">
    <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
      <span class="inline-block h-4 w-1 rounded-full" style="background:linear-gradient(180deg,#6366F1,#EC4899)"></span>G · Conviction
    </div>
    <div class="flex items-center gap-3 mt-2 mb-3">
      <i data-lucide="${s.icon}" class="w-7 h-7 ${s.text}"></i>
      <span class="font-display text-2xl font-bold ${s.text}">${escapeHtml(dash(v))}</span>
    </div>
    <p class="text-slate-700 leading-relaxed">${escapeHtml(dash(ns.conviction_note))}</p>
    <p class="text-[11px] text-slate-400 mt-3 border-t border-slate-200/70 pt-3">
      A research observation, <span class="font-semibold">not investment advice</span> — Munshot is not a SEBI-registered investment adviser. Do your own diligence.
    </p>
    <div class="grid sm:grid-cols-2 gap-5 mt-5">
      ${list("Monitorables", monitor, "activity")}
      ${list("Re-rating triggers", triggers, "zap")}
    </div>
  </section>`;
}

// ── E/F financial model — pure recompute + seed ──────────────────────────────
const asNum = (v, fb) => (typeof v === "number" && isFinite(v) ? v : fb);
const fmtCr0 = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v).toLocaleString("en-IN") : "—");
const fmt1 = (v) => (typeof v === "number" && isFinite(v) ? v.toFixed(1) : "—");
const fmtMult = (v) => (typeof v === "number" && isFinite(v) ? `${v.toFixed(1)}x` : "n.m."); // null/±Inf/NaN → n.m.

/** Rows the model recomputes; the rest (gross_margin_pct, adj_ebitda_margin_pct) are display-only. */
const MODEL_COMPUTED = new Set(["revenue", "ebitda", "ebitda_margin_pct", "pat", "net_margin_pct"]);

/** Expected unit per key. The schema doesn't couple key↔unit, so the model validates it. */
const KEY_UNITS = { revenue: "rs_cr", gross_margin_pct: "pct", ebitda: "rs_cr", ebitda_margin_pct: "pct", adj_ebitda_margin_pct: "pct", pat: "rs_cr", net_margin_pct: "pct" };

/** Find a financial row by key, validating its unit — a wrong-unit row (e.g. revenue tagged
 *  "pct") is ignored so the model never treats a percentage as ₹ crore and corrupts E/F. */
const rowByKey = (report, key) => {
  const r = (report.financials?.rows ?? []).find((x) => x.key === key);
  if (!r) return {};
  return KEY_UNITS[key] && r.unit !== KEY_UNITS[key] ? {} : r;
};

/** Seed the editable levers from assumptions + the FY27/FY28 row values + inputs.cmp. */
export function seedEdits(report) {
  const a = report.financials?.assumptions ?? {};
  const inputs = report.meta?.inputs ?? {};
  const em = rowByKey(report, "ebitda_margin_pct");
  const nm = rowByKey(report, "net_margin_pct");
  const rev = rowByKey(report, "revenue"), eb = rowByKey(report, "ebitda"), pat = rowByKey(report, "pat");
  // When a margin row is null, infer it from the reported abs rows (ebitda/pat ÷ revenue) — this
  // preserves the validated artifact. Prefer the implied value OVER assumptions.margin, which may
  // be rounded/divergent. Returns null when it can't be computed so the fallback chain continues.
  const impliedMargin = (numer, denom) => {
    const n = asNum(numer, null), d = asNum(denom, null);
    return n !== null && d !== null && d !== 0 ? (n / d) * 100 : null;
  };
  return {
    growth_fy27: asNum(a.revenue_growth?.fy27, 0),
    growth_fy28: asNum(a.revenue_growth?.fy28, 0),
    ebitda_margin_fy27: asNum(em.fy27e, asNum(impliedMargin(eb.fy27e, rev.fy27e), asNum(a.margin?.fy27, 0))),
    ebitda_margin_fy28: asNum(em.fy28e, asNum(impliedMargin(eb.fy28e, rev.fy28e), asNum(a.margin?.fy28, 0))),
    net_margin_fy27: asNum(nm.fy27e, asNum(impliedMargin(pat.fy27e, rev.fy27e), 0)),
    net_margin_fy28: asNum(nm.fy28e, asNum(impliedMargin(pat.fy28e, rev.fy28e), 0)),
    cmp: asNum(inputs.cmp, 0),
  };
}

/**
 * PURE deterministic recompute. Returns the forecast rows + valuation for the given edits.
 * Keys off row `key` (never labels). Guardrails: a multiple with denominator ≤ 0 → null (→ "n.m.").
 */
export function computeModel(report, edits) {
  const e = edits || {};
  const inputs = report.meta?.inputs ?? {};
  const revRow = rowByKey(report, "revenue");

  const g27 = asNum(e.growth_fy27, 0), g28 = asNum(e.growth_fy28, 0);
  // Base-year revenue. FY26A is nullable in the schema — if it's absent, back out an implied
  // base from the reported FY27E using the report's OWN growth assumption (the seed, not the
  // edited lever), so at seed it reconciles to FY27E AND the FY27 growth lever still moves FY27.
  let revA = asNum(revRow.fy26a, null);
  if (revA === null) {
    const f27 = asNum(revRow.fy27e, null);
    const seedG = asNum(report.financials?.assumptions?.revenue_growth?.fy27, 0);
    revA = f27 !== null && 1 + seedG / 100 !== 0 ? f27 / (1 + seedG / 100) : 0;
  }

  const em27 = asNum(e.ebitda_margin_fy27, 0), em28 = asNum(e.ebitda_margin_fy28, 0);
  const nm27 = asNum(e.net_margin_fy27, 0), nm28 = asNum(e.net_margin_fy28, 0);
  const cmp = Math.max(0, asNum(e.cmp, asNum(inputs.cmp, 0))); // a price can't be negative
  const shares = asNum(inputs.shares_out_cr, 0), netDebt = asNum(inputs.net_debt_cr, 0);

  const rev27 = revA * (1 + g27 / 100);
  const rev28 = rev27 * (1 + g28 / 100);
  const eb27 = (rev27 * em27) / 100, eb28 = (rev28 * em28) / 100;
  const pat27 = (rev27 * nm27) / 100, pat28 = (rev28 * nm28) / 100;

  const marketCap = cmp * shares;
  const ev = marketCap + netDebt;
  const ratio = (n, d) => (typeof d === "number" && d > 0 ? n / d : null); // ≤0 denominator → n.m.

  return {
    revenue: { fy26a: revA, fy27e: rev27, fy28e: rev28 },
    ebitda: { fy27e: eb27, fy28e: eb28 },
    ebitda_margin_pct: { fy27e: em27, fy28e: em28 },
    pat: { fy27e: pat27, fy28e: pat28 },
    net_margin_pct: { fy27e: nm27, fy28e: nm28 },
    valuation: {
      cmp, marketCap, ev,
      pe: { fy27e: ratio(marketCap, pat27), fy28e: ratio(marketCap, pat28) },
      ev_ebitda: { fy27e: ratio(ev, eb27), fy28e: ratio(ev, eb28) },
      price_sales: { fy27e: ratio(marketCap, rev27), fy28e: ratio(marketCap, rev28) },
    },
  };
}

/**
 * The as-generated (validated) values, in the same shape computeModel returns. Shown on the
 * initial/unedited view so Section E rows and Section F multiples reconcile EXACTLY with the
 * report JSON (no recompute drift); computeModel takes over once the user edits a lever.
 */
function artifactValues(report) {
  const g = (k) => rowByKey(report, k);
  const val = report.valuation ?? {};
  const inputs = report.meta?.inputs ?? {};
  const mc = asNum(inputs.market_cap_cr, asNum(inputs.cmp, 0) * asNum(inputs.shares_out_cr, 0));
  const yrs = (k) => ({ fy27e: g(k).fy27e, fy28e: g(k).fy28e });
  return {
    revenue: yrs("revenue"),
    ebitda: yrs("ebitda"),
    ebitda_margin_pct: yrs("ebitda_margin_pct"),
    pat: yrs("pat"),
    net_margin_pct: yrs("net_margin_pct"),
    valuation: { cmp: asNum(inputs.cmp, 0), marketCap: mc, ev: mc + asNum(inputs.net_debt_cr, 0), pe: val.pe ?? {}, ev_ebitda: val.ev_ebitda ?? {}, price_sales: val.price_sales ?? {} },
  };
}

/**
 * The values to DISPLAY for the given edit state. GRANULAR PER-YEAR, PER-CELL — each cell only
 * recomputes when ITS OWN inputs changed, so editing one assumption never disturbs an untouched
 * year or line:
 *   • nothing edited   → the validated artifact (exact; reconciles with report.valuation).
 *   • growth_fyN       → revenue.fyN recomputes (FY28 also depends on FY27 growth, as it compounds).
 *   • margin_fyN       → only that year's EBITDA/PAT re-derive, off the DISPLAYED revenue (artifact
 *                        when growth is untouched — so no rounding drift leaks into other years).
 *   • CMP              → only market cap / EV / multiples move.
 */
export function displayModel(report, current, seed) {
  const chg = (k) => current[k] !== seed[k];
  const g27 = chg("growth_fy27"), g28 = chg("growth_fy28");
  const em27 = chg("ebitda_margin_fy27"), em28 = chg("ebitda_margin_fy28");
  const nm27 = chg("net_margin_fy27"), nm28 = chg("net_margin_fy28");
  if (!g27 && !g28 && !em27 && !em28 && !nm27 && !nm28 && !chg("cmp")) return artifactValues(report);

  const art = artifactValues(report);
  const comp = computeModel(report, current);
  // FY28 revenue compounds off FY27, so it moves if either growth lever changed.
  const rev27changed = g27, rev28changed = g27 || g28;
  const revenue = {
    fy27e: rev27changed ? comp.revenue.fy27e : art.revenue.fy27e,
    fy28e: rev28changed ? comp.revenue.fy28e : art.revenue.fy28e,
  };
  const em = { fy27e: asNum(current.ebitda_margin_fy27, 0), fy28e: asNum(current.ebitda_margin_fy28, 0) };
  const nm = { fy27e: asNum(current.net_margin_fy27, 0), fy28e: asNum(current.net_margin_fy28, 0) };
  // EBITDA/PAT for a year re-derive (off that year's DISPLAYED revenue) only if its revenue or its
  // own margin changed; otherwise the reported row is preserved exactly.
  const ebitda = {
    fy27e: rev27changed || em27 ? (revenue.fy27e * em.fy27e) / 100 : art.ebitda.fy27e,
    fy28e: rev28changed || em28 ? (revenue.fy28e * em.fy28e) / 100 : art.ebitda.fy28e,
  };
  const pat = {
    fy27e: rev27changed || nm27 ? (revenue.fy27e * nm.fy27e) / 100 : art.pat.fy27e,
    fy28e: rev28changed || nm28 ? (revenue.fy28e * nm.fy28e) / 100 : art.pat.fy28e,
  };

  const inputs = report.meta?.inputs ?? {};
  const shares = asNum(inputs.shares_out_cr, 0), netDebt = asNum(inputs.net_debt_cr, 0);
  const cmp = Math.max(0, asNum(current.cmp, asNum(inputs.cmp, 0))); // a price can't be negative
  const marketCap = cmp * shares, ev = marketCap + netDebt;
  const ratio = (n, d) => (typeof d === "number" && d > 0 ? n / d : null);
  return {
    revenue, ebitda, pat,
    ebitda_margin_pct: { fy27e: em.fy27e, fy28e: em.fy28e },
    net_margin_pct: { fy27e: nm.fy27e, fy28e: nm.fy28e },
    valuation: {
      marketCap, ev,
      pe: { fy27e: ratio(marketCap, pat.fy27e), fy28e: ratio(marketCap, pat.fy28e) },
      ev_ebitda: { fy27e: ratio(ev, ebitda.fy27e), fy28e: ratio(ev, ebitda.fy28e) },
      price_sales: { fy27e: ratio(marketCap, revenue.fy27e), fy28e: ratio(marketCap, revenue.fy28e) },
    },
  };
}

/** [mgmt guidance] vs [Est.] basis tag — derived from whether management guided the metric on the call. */
function leverBasis(report, keywords) {
  const g = report.concall?.guidance ?? [];
  const hit = g.find(
    (x) => (x.source === "Transcript" || x.source === "PPT") && keywords.some((k) => String(x.metric || "").toLowerCase().includes(k))
  );
  return hit ? "mgmt guidance" : "Est.";
}
function basisPill(kind) {
  const mgmt = kind === "mgmt guidance";
  const cls = mgmt ? "bg-blue-50 text-blue-700 ring-blue-200" : "bg-slate-100 text-slate-600 ring-slate-200";
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${cls} whitespace-nowrap">${escapeHtml(mgmt ? "mgmt guidance" : "Est.")}</span>`;
}
function levInput(key, val, yr, unit) {
  const suffix = unit === "%" ? `<span class="text-slate-400 text-xs">%</span>` : "";
  return `<label class="inline-flex items-center gap-1 text-xs text-slate-500">
    <span>${escapeHtml(yr)}</span>
    <input type="number" step="0.1" inputmode="decimal" data-lever="${escapeHtml(key)}" value="${escapeHtml(String(val))}"
      class="w-20 rounded-lg border border-slate-200 px-2 py-1 text-sm font-mono text-slate-800 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100" />${suffix}
  </label>`;
}

// ── E · editable financial model ─────────────────────────────────────────────
function financialModelSection(report) {
  const rows = report.financials?.rows ?? [];
  if (!rows.length) return sectionCard("E · Financial model (₹ Cr)", empty("No financial model."));
  const seed = seedEdits(report);
  // Initial view = the as-generated artifact (reconciles exactly with the report JSON);
  // hydrateModel switches to computeModel once a lever is edited.
  const m = artifactValues(report);
  const compSrc = { revenue: m.revenue, ebitda: m.ebitda, ebitda_margin_pct: m.ebitda_margin_pct, pat: m.pat, net_margin_pct: m.net_margin_pct };

  // A forecast cell: computed rows get a data-out hook + live value; display-only rows show baseline.
  const cell = (row, yr) => {
    const isPct = row.unit === "pct";
    const fmt = isPct ? fmt1 : fmtCr0;
    const suf = isPct ? `<span class="text-slate-400">%</span>` : "";
    if (MODEL_COMPUTED.has(row.key)) {
      return `<span data-out="${row.key}-${yr}" class="font-mono text-slate-800">${fmt(compSrc[row.key][yr])}</span>${suf}`;
    }
    const v = row[yr];
    const has = typeof v === "number" && isFinite(v);
    return `<span class="font-mono text-slate-400">${has ? fmt(v) : "—"}</span>${has ? suf : ""}`;
  };
  const fy26 = (row) => {
    const isPct = row.unit === "pct";
    const v = row.fy26a;
    const has = typeof v === "number" && isFinite(v);
    return `<span class="font-mono text-slate-500">${has ? (isPct ? fmt1(v) : fmtCr0(v)) : "—"}</span>${has && isPct ? `<span class="text-slate-400">%</span>` : ""}`;
  };
  const tbl = table(
    ["Metric", "FY26A", "FY27E", "FY28E", "Driver"],
    rows.map((r) => [
      `<span class="font-medium text-slate-800">${escapeHtml(dash(r.metric))}</span>`,
      fy26(r),
      cell(r, "fy27e"),
      cell(r, "fy28e"),
      `<span class="text-slate-500">${escapeHtml(dash(r.driver))}</span>`,
    ]),
    [, "num", "num", "num"] // FY26A / FY27E / FY28E right-aligned
  );

  const a = report.financials?.assumptions ?? {};
  const lever = (label, k27, k28, basis) => `
    <div class="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4 py-2">
      <div class="sm:w-52 flex items-center gap-2"><span class="text-sm font-medium text-slate-700">${escapeHtml(label)}</span>${basisPill(basis)}</div>
      <div class="flex flex-wrap gap-3">${levInput(k27, seed[k27], "FY27E", "%")}${levInput(k28, seed[k28], "FY28E", "%")}</div>
    </div>`;
  const basisNotes = [a.revenue_growth?.basis && `Growth basis: ${a.revenue_growth.basis}`, a.margin?.basis && `Margin basis: ${a.margin.basis}`, a.note]
    .filter(Boolean)
    .map((t) => `<p class="text-xs text-slate-400">${escapeHtml(t)}</p>`)
    .join("");
  const assumptions = `
    <div class="mt-6 rounded-2xl bg-slate-50 ring-1 ring-inset ring-slate-100 p-4 sm:p-5">
      <div class="flex items-center gap-2 mb-2">
        <i data-lucide="sliders-horizontal" class="w-4 h-4 text-indigo-600"></i>
        <h4 class="font-semibold text-slate-700">Assumptions <span class="font-normal text-slate-400 text-sm">— edit to re-model</span></h4>
      </div>
      <div class="divide-y divide-slate-100">
        ${lever("Revenue growth", "growth_fy27", "growth_fy28", leverBasis(report, ["revenue"]))}
        ${lever("EBITDA margin", "ebitda_margin_fy27", "ebitda_margin_fy28", leverBasis(report, ["ebitda"]))}
        ${lever("Net margin", "net_margin_fy27", "net_margin_fy28", leverBasis(report, ["net margin"]))}
      </div>
      <div class="mt-3 space-y-1">${basisNotes}</div>
    </div>`;

  const head = `
    <div class="flex items-center justify-between gap-3 mb-4">
      <h3 class="font-display text-lg font-bold flex items-center gap-2">
        <span class="inline-block h-4 w-1 rounded-full" style="background:linear-gradient(180deg,#6366F1,#EC4899)"></span>
        E · Financial model <span class="text-sm font-normal text-slate-400">(₹ Cr)</span>
      </h3>
      <div class="flex items-center gap-2">
        <span data-model-edited class="hidden inline-flex items-center gap-1 rounded-full bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 px-2 py-0.5 text-xs font-semibold"><i data-lucide="pencil" class="w-3 h-3"></i>edited</span>
        <button type="button" data-model-reset class="hidden rounded-full ring-1 ring-inset ring-slate-200 text-slate-600 px-3 py-1 text-xs font-semibold hover:bg-slate-50">Reset</button>
      </div>
    </div>`;
  return `<section class="card fade-in p-6 sm:p-8 mb-6">${head}${tbl}${assumptions}</section>`;
}

// ── F · live valuation ───────────────────────────────────────────────────────
function valuationSection(report) {
  const seed = seedEdits(report);
  const m = artifactValues(report); // initial view = validated artifact; goes live once edited
  const priceLever = `
    <div class="flex flex-wrap items-end gap-x-6 gap-y-3 mb-5">
      <label class="flex flex-col gap-1">
        <span class="text-xs font-semibold text-slate-500">What-if price (CMP)</span>
        <span class="inline-flex items-center gap-1"><span class="text-slate-400">₹</span>
          <input type="number" step="1" min="0" inputmode="decimal" data-lever="cmp" value="${escapeHtml(String(seed.cmp))}" class="w-28 rounded-lg border border-slate-200 px-2 py-1 text-sm font-mono text-slate-800 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100" />
        </span>
      </label>
      <div><div class="text-xs text-slate-500">Market cap</div><div class="font-mono text-slate-800">₹<span data-out="marketcap">${fmtCr0(m.valuation.marketCap)}</span>cr</div></div>
      <div><div class="text-xs text-slate-500">EV</div><div class="font-mono text-slate-800">₹<span data-out="ev">${fmtCr0(m.valuation.ev)}</span>cr</div></div>
      <div class="text-xs text-slate-400 self-center">shares &amp; net debt fixed from inputs</div>
    </div>`;
  const vc = (name, yr, v) => `<span data-val="${name}-${yr}" class="font-mono font-medium text-slate-800">${fmtMult(v)}</span>`;
  const valTbl = table(
    ["Multiple", "FY27E", "FY28E"],
    [
      [`<span class="font-medium text-slate-800">P/E</span>`, vc("pe", "fy27e", m.valuation.pe.fy27e), vc("pe", "fy28e", m.valuation.pe.fy28e)],
      [`<span class="font-medium text-slate-800">EV/EBITDA</span>`, vc("evebitda", "fy27e", m.valuation.ev_ebitda.fy27e), vc("evebitda", "fy28e", m.valuation.ev_ebitda.fy28e)],
      [`<span class="font-medium text-slate-800">P/S</span>`, vc("ps", "fy27e", m.valuation.price_sales.fy27e), vc("ps", "fy28e", m.valuation.price_sales.fy28e)],
    ],
    [, "num", "num"]
  );
  const sanity = report.valuation?.sanity_check
    ? `<div class="mt-4 rounded-xl bg-indigo-50/60 ring-1 ring-inset ring-indigo-100 p-4">
         <div class="flex items-center gap-2 text-indigo-700 font-semibold text-sm mb-1"><i data-lucide="scale" class="w-4 h-4"></i>Sanity check <span class="font-normal text-slate-400">(as generated)</span></div>
         <p class="text-sm text-slate-600 leading-relaxed">${escapeHtml(report.valuation.sanity_check)}</p>
         <p data-sanity-edited class="hidden text-xs text-amber-600 mt-2 font-medium">⚠ Reflects the original assumptions — your edits above are not reflected in this text.</p>
       </div>`
    : "";
  return sectionCard("F · Valuation", `${priceLever}${valTbl}${sanity}`);
}

/**
 * Wire Section E's assumption inputs so E's rows and F's multiples recompute live.
 * Call AFTER renderReport()'s HTML is mounted. No-ops if there's no model in the DOM.
 */
export function hydrateModel(report, root) {
  if (!root) return;
  const levers = Array.from(root.querySelectorAll("[data-lever]"));
  if (!levers.length) return;
  const seed = seedEdits(report);
  const current = { ...seed };
  const editedEl = root.querySelector("[data-model-edited]");
  const resetEl = root.querySelector("[data-model-reset]");
  const sanityNote = root.querySelector("[data-sanity-edited]");
  const set = (sel, txt) => { const el = root.querySelector(sel); if (el) el.textContent = txt; };

  function render() {
    const edited = Object.keys(seed).some((k) => current[k] !== seed[k]);
    // displayModel handles the three states: unedited → validated artifact; CMP-only → price
    // re-value on artifact earnings; operating edit → full live recompute.
    const m = displayModel(report, current, seed);
    ["revenue", "ebitda", "pat"].forEach((k) => {
      set(`[data-out="${k}-fy27e"]`, fmtCr0(m[k].fy27e));
      set(`[data-out="${k}-fy28e"]`, fmtCr0(m[k].fy28e));
    });
    ["ebitda_margin_pct", "net_margin_pct"].forEach((k) => {
      set(`[data-out="${k}-fy27e"]`, fmt1(m[k].fy27e));
      set(`[data-out="${k}-fy28e"]`, fmt1(m[k].fy28e));
    });
    set('[data-out="marketcap"]', fmtCr0(m.valuation.marketCap));
    set('[data-out="ev"]', fmtCr0(m.valuation.ev));
    const putv = (name, obj) => { set(`[data-val="${name}-fy27e"]`, fmtMult(obj.fy27e)); set(`[data-val="${name}-fy28e"]`, fmtMult(obj.fy28e)); };
    putv("pe", m.valuation.pe);
    putv("evebitda", m.valuation.ev_ebitda);
    putv("ps", m.valuation.price_sales);

    if (editedEl) editedEl.classList.toggle("hidden", !edited);
    if (resetEl) resetEl.classList.toggle("hidden", !edited);
    // Stored sanity_check prose is frozen at the original assumptions — flag it once edited.
    if (sanityNote) sanityNote.classList.toggle("hidden", !edited);
  }

  levers.forEach((el) => {
    el.addEventListener("input", () => {
      const key = el.getAttribute("data-lever");
      const v = parseFloat(el.value);
      // Ignore non-numeric (keep last valid); reject negative CMP (a price can't be < 0).
      if (Number.isFinite(v) && !(key === "cmp" && v < 0)) current[key] = v;
      render();
    });
  });
  if (resetEl) {
    resetEl.addEventListener("click", () => {
      Object.assign(current, seed);
      levers.forEach((el) => { el.value = seed[el.getAttribute("data-lever")]; });
      render();
    });
  }
  render();
}

// ── Sources panel (bibliography) ─────────────────────────────────────────────
function sourcesSection(report) {
  const s = report.meta?.sources ?? {};
  const docRow = (label, url, icon) => url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 text-sm text-indigo-600 hover:underline"><i data-lucide="${icon}" class="w-4 h-4 shrink-0"></i>${escapeHtml(label)}<i data-lucide="external-link" class="w-3 h-3 opacity-60"></i></a>`
    : `<span class="flex items-center gap-2 text-sm text-slate-400"><i data-lucide="${icon}" class="w-4 h-4 shrink-0"></i>${escapeHtml(label)} — not available</span>`;
  const docs = [
    docRow("Concall transcript", s.transcript_url, "file-text"),
    docRow("Investor presentation", s.ppt_url, "presentation"),
    s.concall_date ? `<span class="flex items-center gap-2 text-sm text-slate-500"><i data-lucide="calendar" class="w-4 h-4 shrink-0"></i>Concall held ${escapeHtml(s.concall_date)}</span>` : "",
  ].filter(Boolean).join("");
  const web = collectWebSources(report);
  const webList = web.length
    ? `<div class="mt-5"><h4 class="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">Web sources</h4><ul class="space-y-2">${web
        .map((w) => `<li class="flex items-baseline gap-2"><i data-lucide="globe" class="w-3.5 h-3.5 text-slate-400 shrink-0 translate-y-0.5"></i><a href="${escapeHtml(w.url)}" target="_blank" rel="noopener noreferrer" class="text-sm text-indigo-600 hover:underline">${escapeHtml(w.title || hostOf(w.url))}</a><span class="text-xs text-slate-400 font-mono">${escapeHtml(hostOf(w.url))}</span></li>`)
        .join("")}</ul></div>`
    : "";
  const note = `<p class="text-xs text-slate-400 mt-5 border-t border-slate-100 pt-3">Every sourced fact links to where it came from. Transcript &amp; deck open as PDFs — tap <i data-lucide="search" class="inline w-3 h-3"></i> to copy the exact quote, then Ctrl+F it in the document. Web sources open scrolled to the highlighted line.</p>`;
  return sectionCard("Sources &amp; provenance", `<div class="grid sm:grid-cols-2 gap-3">${docs}</div>${webList}${note}`);
}

/** Wire the ⌕ "copy quote to search" buttons (call after renderReport mounts). Copies the verbatim
 *  quote so the reader can Ctrl+F in the (PDF) source; flips to a ✓ briefly. No-op if none present. */
export function hydrateProvenance(root) {
  if (!root) return;
  root.querySelectorAll(".src-copy").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      const q = btn.getAttribute("data-quote") || "";
      try { await navigator.clipboard.writeText(q); } catch { /* clipboard may be blocked in the sandbox */ }
      const prev = btn.innerHTML;
      btn.innerHTML = `<i data-lucide="check" class="w-2.5 h-2.5"></i>`;
      btn.classList.add("text-emerald-600", "ring-emerald-200");
      if (window.lucide?.createIcons) window.lucide.createIcons();
      setTimeout(() => {
        btn.innerHTML = prev; btn.classList.remove("text-emerald-600", "ring-emerald-200");
        if (window.lucide?.createIcons) window.lucide.createIcons();
      }, 1200);
    });
  });
}

// ── entry point ─────────────────────────────────────────────────────────────
/** The in-report section-nav map (ids must match the anchors below). Consumed by app.js's scroll-spy. */
export const REPORT_SECTIONS = [
  { id: "sec-takeaways", label: "Key Takeaways" },
  { id: "sec-about", label: "About" },
  { id: "sec-concall", label: "Concall" },
  { id: "sec-thesis", label: "Thesis" },
  { id: "sec-model", label: "Model" },
  { id: "sec-valuation", label: "Valuation" },
  { id: "sec-verdict", label: "Verdict" },
  { id: "sec-sources", label: "Sources" },
];

const anchor = (id, html) => `<div id="${id}">${html}</div>`;

/**
 * Render the full report as an HTML string. Order: header → B → C.1–C.8 → D → E → F → G.
 * Sections are wrapped in scroll-spy anchors (REPORT_SECTIONS). `headerStrip` (CMP/mkt-cap/net-debt
 * + the [PPT-ONLY]/unconfirmed banners) is always included; app.js adds the back/regenerate bar above.
 */
export function renderReport(report) {
  const r = report || {};
  return [
    headerStrip(r),
    anchor("sec-takeaways", keyTakeaways(r)),
    anchor("sec-about", aboutSection(r)),
    anchor("sec-concall", [
      guidanceSection(r), themesSection(r), expansionSection(r), thesisTriggersSection(r),
      classificationSection(r), risksSection(r), managementToneSection(r), analystToneSection(r),
    ].join("\n")),
    anchor("sec-thesis", thesisAntiThesisSection(r)),
    anchor("sec-model", financialModelSection(r)),
    anchor("sec-valuation", valuationSection(r)),
    anchor("sec-verdict", convictionSection(r)),
    anchor("sec-sources", sourcesSection(r)),
  ].join("\n");
}
