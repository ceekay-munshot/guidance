// report.js — read-only report renderer (STEP 3: PART 1).
// Pure: takes the loaded report object and returns an HTML string. Renders strictly
// from report.schema.json's shape. ALL rendered strings are escaped — the data will be
// LLM-generated later, so treat it as untrusted.
//
// Sections built here: header strip, Key Takeaways (hero), B (about), C.1 guidance,
// C.2 themes, C.3 expansion flags, C.4 thesis-triggers. C.5–C.8 / D / E / F / G render
// as light "coming next" headers (Steps 4–5 fill them in).
//
// Reusable helpers Steps 4–5 lean on: sourceTag(), stancePill(), chip(), badge(),
// sectionCard(), table(). Keep them small and composable.

import { escapeHtml } from "./ui.js";

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

/** Responsive table. `headers` are escaped; `rows` are arrays of pre-built HTML cells. */
function table(headers, rows) {
  const head = headers
    .map((h) => `<th class="text-left font-semibold text-slate-500 text-[11px] uppercase tracking-wide px-3 py-2 whitespace-nowrap">${escapeHtml(h)}</th>`)
    .join("");
  const body = rows
    .map((cells) => `<tr class="border-t border-slate-100 align-top">${cells.map((c) => `<td class="px-3 py-2.5 text-sm text-slate-700">${c}</td>`).join("")}</tr>`)
    .join("");
  // overflow-x wrapper so the page never scrolls sideways on mobile.
  return `<div class="overflow-x-auto"><table class="w-full min-w-[560px] border-collapse"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const empty = (msg = "—") => `<p class="text-sm text-slate-400">${escapeHtml(msg)}</p>`;

/** Light "coming next" placeholder for sections not built yet (no fake content). */
function comingNext(label) {
  return `
  <div class="fade-in mb-3 flex items-center gap-2 rounded-xl border border-dashed border-slate-200 px-4 py-3 text-slate-400">
    <i data-lucide="chevron-right" class="w-4 h-4"></i>
    <span class="font-medium text-sm">${escapeHtml(label)}</span>
    <span class="text-xs">— coming next</span>
  </div>`;
}

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
          sourceTag(x.source) || "—",
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
              <div class="flex items-center gap-2 shrink-0">${stancePill(t.stance)}${sourceTag(t.source)}</div>
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

// ── coming-next outline (Steps 4–5) ─────────────────────────────────────────
const UPCOMING = [
  "C.5 · Classification tags",
  "C.6 · Risks",
  "C.7 · Management tone",
  "C.8 · Analyst tone",
  "D · Thesis vs Anti-thesis",
  "E · Financial model",
  "F · Valuation",
  "G · Conviction / verdict",
];

// ── entry point ─────────────────────────────────────────────────────────────
/** Render the full report (Part 1 sections + the outline of what's next) as an HTML string. */
export function renderReport(report) {
  const r = report || {};
  return [
    headerStrip(r),
    keyTakeaways(r),
    aboutSection(r),
    guidanceSection(r),
    themesSection(r),
    expansionSection(r),
    thesisTriggersSection(r),
    `<div class="mt-8 mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Coming in Steps 4–5</div>`,
    ...UPCOMING.map(comingNext),
  ].join("\n");
}
