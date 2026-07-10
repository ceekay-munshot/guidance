// salvage.mjs — best-effort partial reports (Step 12 follow-up).
//
// The finalize gate used to DISCARD a whole report if any single field violated report.schema.json —
// so one unavailable/odd field (an undisclosed margin, an n.m. multiple, a dropped section) meant the
// client saw a generic error instead of a 95%-complete analysis. salvageReport() fixes that WITHOUT
// silently shipping wrong data: it blanks/drops ONLY best-effort fields (clearly recorded in
// `degraded`), and still hard-fails when a LOAD-BEARING part (identity, price inputs, the financial
// model, the verdict, the takeaways) is broken — because a confidently-wrong number in an investment
// note is worse than a visible gap.

import { validate } from "./validate.mjs";

// ── dotted-path get/set on the report, and the matching node in the schema ──
const get = (o, path) => path.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
function setPath(o, path, val) {
  const ks = path.split("."); const last = ks.pop();
  let cur = o;
  for (const k of ks) { if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {}; cur = cur[k]; }
  cur[last] = val;
}
function schemaAt(root, path) {
  let node = root;
  for (const k of path.split(".")) { node = node && node.properties && node.properties[k]; if (!node) return null; }
  return node;
}

// Best-effort ARRAYS: coerce to [] if not an array; drop items that fail their item schema.
const BEST_EFFORT_ARRAYS = [
  "about.products", "about.segments", "about.revenue_mix", "about.margin_by_segment",
  "concall.guidance", "concall.themes", "concall.expansion_flags", "concall.thesis_triggers",
  "concall.classification", "concall.risks", "concall.management_tone", "concall.analyst_tone.hot_themes",
  "thesis", "anti_thesis", "next_steps.monitorables", "next_steps.rerating_triggers",
];
// Best-effort SCALARS/enums: replace with a safe default when invalid.
const BEST_EFFORT_SCALARS = [
  ["about.sector", "Unspecified"], ["about.sub_sector", "Unspecified"], ["about.segment_reported", false],
  ["concall.tone_shift_vs_last_quarter", "unknown"], ["concall.analyst_tone.qa_tenor", "perfunctory"],
  ["valuation.sanity_check", ""],
];
const NM = () => ({ fy27e: null, fy28e: null }); // a multiple that can't be computed → "n.m."
// Coarse fallback: if a best-effort SECTION is still structurally invalid, drop to a schema-valid empty.
const SECTION_SKELETONS = {
  about: () => ({ sector: "Unspecified", sub_sector: "Unspecified", products: [], segments: [], segment_reported: false, revenue_mix: [], margin_by_segment: [] }),
  concall: () => ({ guidance: [], themes: [], tone_shift_vs_last_quarter: "unknown", expansion_flags: [], thesis_triggers: [], classification: [], risks: [], management_tone: [], analyst_tone: { hot_themes: [], qa_tenor: "perfunctory" } }),
  valuation: () => ({ pe: NM(), ev_ebitda: NM(), price_sales: NM(), sanity_check: "" }),
  thesis: () => [],
  anti_thesis: () => [],
};
// LOAD-BEARING: if a violation remains under one of these after salvage, we hard-fail (never fake it).
const LOAD_BEARING = ["$.meta", "$.financials", "$.key_takeaways", "$.next_steps"];

/**
 * Try to make `report` schema-valid by degrading only best-effort fields. Returns:
 *   { report, ok, degraded, fatal, errors }
 * `ok` is true when nothing load-bearing is broken (publish it, partial if `degraded` is non-empty);
 * `fatal` lists the load-bearing violations that could not be salvaged (hard-fail).
 */
export function salvageReport(report, schema) {
  const r = JSON.parse(JSON.stringify(report));
  const degraded = [];

  // 0 · strip stray top-level keys (root is additionalProperties:false; stripInternal only drops
  // `_`-prefixed ones) so a genuinely-valid salvage is achievable and `ok` can mean "schema-valid".
  for (const k of Object.keys(r)) if (!(schema.properties && schema.properties[k])) { delete r[k]; degraded.push(`${k}: unexpected top-level key removed`); }

  // 1 · best-effort arrays — materialize a MISSING or non-array field to [] (a missing best-effort
  // array must not hard-fail — e.g. next_steps.monitorables lives in the load-bearing verdict object,
  // so it has no section skeleton), then drop items that fail their item schema.
  for (const path of BEST_EFFORT_ARRAYS) {
    const node = schemaAt(schema, path);
    if (!node || !node.items) continue;
    const list = get(r, path);
    if (!Array.isArray(list)) { setPath(r, path, []); if (list !== undefined) degraded.push(`${path}: unavailable`); continue; }
    const kept = list.filter((it) => validate(node.items, it, schema).length === 0);
    if (kept.length !== list.length) { setPath(r, path, kept); degraded.push(`${path}: dropped ${list.length - kept.length} malformed item(s)`); }
  }

  // 2 · best-effort scalars/enums — safe default when invalid
  for (const [path, def] of BEST_EFFORT_SCALARS) {
    const node = schemaAt(schema, path);
    if (node && validate(node, get(r, path), schema).length) { setPath(r, path, def); degraded.push(`${path}: unavailable`); }
  }

  // 3 · valuation multiples — a malformed multiple becomes "n.m." (null)
  for (const m of ["pe", "ev_ebitda", "price_sales"]) {
    const node = schemaAt(schema, `valuation.${m}`);
    if (node && validate(node, get(r, `valuation.${m}`), schema).length) {
      if (!r.valuation || typeof r.valuation !== "object") r.valuation = SECTION_SKELETONS.valuation();
      setPath(r, `valuation.${m}`, NM()); degraded.push(`valuation.${m}: n.m.`);
    }
  }

  // 4 · coarse fallback — any best-effort SECTION still invalid → schema-valid empty skeleton
  for (const sec of Object.keys(SECTION_SKELETONS)) {
    const node = schema.properties && schema.properties[sec];
    if (node && validate(node, r[sec], schema).length) { r[sec] = SECTION_SKELETONS[sec](); degraded.push(`${sec}: replaced with empty (unavailable)`); }
  }

  // 5 · publish ONLY if the salvaged report is genuinely schema-valid (not merely free of load-bearing
  // errors) — otherwise we'd emit invalid JSON as a "partial" report and break the contract. `fatal`
  // is kept for diagnostics: load-bearing violations are the expected reason a report can't be salvaged.
  const errors = validate(schema, r, schema);
  const fatal = errors.filter((e) => LOAD_BEARING.some((p) => e.startsWith(p)));
  return { report: r, ok: errors.length === 0, degraded, fatal, errors };
}
