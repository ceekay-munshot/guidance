// salvage.test.mjs — best-effort partial reports. Confirms salvageReport() publishes a valid report
// by degrading ONLY best-effort fields, and hard-fails only when something load-bearing is broken.
// Run: node pipeline/test/salvage.test.mjs

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { salvageReport } from "../lib/salvage.mjs";
import { validate } from "../lib/validate.mjs";

const F = (p) => fileURLToPath(new URL(p, import.meta.url));
const schema = JSON.parse(await readFile(F("../../public/data/report.schema.json"), "utf8"));
const base = JSON.parse(await readFile(F("../../public/data/sample-report.json"), "utf8"));
const clone = () => JSON.parse(JSON.stringify(base));

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };
const valid = (r) => validate(schema, r, schema).length === 0;

// sanity: the sample report is already valid; salvage leaves it clean & un-degraded
{
  const s = salvageReport(clone(), schema);
  ok(s.ok && s.degraded.length === 0 && valid(s.report), "valid report → ok, no degradation, still valid");
}

// a malformed best-effort ITEM (theme with an out-of-enum stance) → dropped, report published valid
{
  const r = clone();
  r.concall.themes.push({ theme: "Bad", stance: "Bullish", evidence: "x", source: "Transcript" }); // stance not in enum
  const before = r.concall.themes.length;
  const s = salvageReport(r, schema);
  ok(s.ok && valid(s.report), "bad theme item → still ok + valid");
  ok(s.report.concall.themes.length === before - 1, "bad theme item dropped (kept the good ones)");
  ok(s.degraded.some((d) => d.startsWith("concall.themes")), "degradation recorded for concall.themes");
}

// the OLD Vedanta bug shape (string segment margin) → dropped as best-effort, report still valid
{
  const r = clone();
  r.about.margin_by_segment.push({ segment: "Mystery Div", ebitda_margin: "not disclosed" });
  const s = salvageReport(r, schema);
  ok(s.ok && valid(s.report), "string segment margin → salvaged (item dropped), report valid");
  ok(!s.report.about.margin_by_segment.some((m) => typeof m.ebitda_margin === "string"), "no string margins survive salvage");
}

// a malformed valuation multiple → becomes n.m. (null), not a hard fail
{
  const r = clone();
  r.valuation.pe = { fy27e: "n.m.", fy28e: "n.m." }; // strings, invalid
  const s = salvageReport(r, schema);
  ok(s.ok && valid(s.report) && s.report.valuation.pe.fy27e === null, "bad multiple → null (n.m.), report valid");
}

// a totally broken best-effort SECTION → coarse skeleton, still valid
{
  const r = clone();
  r.about = "totally broken";
  const s = salvageReport(r, schema);
  ok(s.ok && valid(s.report) && Array.isArray(s.report.about.revenue_mix), "broken about section → empty skeleton, valid");
  ok(s.degraded.some((d) => d.startsWith("about")), "about replacement recorded");
}

// LOAD-BEARING break — out-of-enum conviction (the verdict) → HARD FAIL (never faked)
{
  const r = clone();
  r.next_steps.conviction = "Strong Buy";
  const s = salvageReport(r, schema);
  ok(!s.ok && s.fatal.some((e) => e.includes("next_steps")), "broken verdict → not ok (fatal), never salvaged");
}

// LOAD-BEARING break — a broken financial model → HARD FAIL
{
  const r = clone();
  r.financials.rows = [{ key: "revenue" }]; // missing required fields + < 6 rows
  const s = salvageReport(r, schema);
  ok(!s.ok && s.fatal.some((e) => e.includes("financials")), "broken financial model → not ok (fatal)");
}

// LOAD-BEARING break — missing price input → HARD FAIL (can't value a company with no price)
{
  const r = clone();
  r.meta.inputs.cmp = null;
  const s = salvageReport(r, schema);
  ok(!s.ok && s.fatal.some((e) => e.includes("meta.inputs.cmp")), "missing CMP → not ok (fatal)");
}

// best-effort next_steps array (monitorables) with a bad item → dropped, verdict preserved, ok
{
  const r = clone();
  r.next_steps.monitorables.push(42); // not a string
  const s = salvageReport(r, schema);
  ok(s.ok && valid(s.report) && !s.report.next_steps.monitorables.includes(42), "bad monitorable dropped, verdict intact, ok");
}

// (Codex P2) a MISSING best-effort array in the load-bearing verdict object → materialized to [],
// recorded as degraded (so the report reads as partial), and NOT a hard fail
{
  const r = clone();
  delete r.next_steps.monitorables;
  const s = salvageReport(r, schema);
  ok(s.ok && valid(s.report) && Array.isArray(s.report.next_steps.monitorables), "missing next_steps.monitorables → [] (not a hard fail)");
  ok(s.degraded.some((d) => d.startsWith("next_steps.monitorables")), "a missing best-effort array is recorded as degraded (report reads partial)");
}

// (Codex P2) a stray non-load-bearing violation (unexpected top-level key) must NOT report ok while invalid
{
  const r = clone();
  r.junk_field = { anything: 1 }; // root is additionalProperties:false → a schema violation, not load-bearing
  const s = salvageReport(r, schema);
  ok(s.ok === valid(s.report), "ok reflects genuine validity, never true-while-invalid");
  ok(s.ok && valid(s.report) && !("junk_field" in s.report), "stray top-level key stripped → valid + ok");
}

console.log(fails === 0 ? "\nSALVAGE (best-effort partial) OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
