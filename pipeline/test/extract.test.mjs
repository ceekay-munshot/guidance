// extract.test.mjs — offline unit tests for Step 7 (no OpenAI, no deps). Run: node pipeline/test/extract.test.mjs
// Uses committed fixtures + a canned LLM response to verify prompt-building, assembly, source-tagging,
// the transcript-only-for-C rule, the PPT-only path, "not disclosed" preservation, and B+C validation.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildMessages, assembleReport, validateBC } from "../lib/extract-assemble.mjs";

const F = (p) => fileURLToPath(new URL(p, import.meta.url));
const bundle = JSON.parse(await readFile(F("../test-fixtures/bundle.sample.json"), "utf8"));
const transcript = await readFile(F("../test-fixtures/transcript.snippet.txt"), "utf8");
const llm = JSON.parse(await readFile(F("../test-fixtures/llm-response.json"), "utf8"));
const schema = JSON.parse(await readFile(F("../../public/data/report.schema.json"), "utf8"));
const ppt = "Investor presentation: segments cGMP, HPP, Specialty Chemicals. Revenue mix chart.";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };

// ── buildMessages (transcript mode) ──
const msgs = buildMessages(bundle, transcript, ppt, { pptOnly: false });
ok(msgs.length === 2 && msgs[0].role === "system" && msgs[1].role === "user", "buildMessages → [system, user]");
ok(msgs[0].content.includes("use the TRANSCRIPT ONLY. Do NOT use the PPT for Section C"), "system enforces transcript-only for Section C");
ok(msgs[0].content.includes("Operating leverage") && msgs[0].content.includes("Turnaround"), "system lists the classification vocabulary");
ok(msgs[1].content.includes("cGMP (CDMO) vertical") && msgs[1].content.includes("Q4FY26"), "user carries the transcript + quarter context");
ok(msgs[1].content.includes("transcript_available=true"), "user flags transcript availability");

// ── buildMessages (PPT-only mode) ──
const pptMsgs = buildMessages(bundle, "", ppt, { pptOnly: true });
ok(pptMsgs[0].content.includes("NO TRANSCRIPT IS AVAILABLE"), "PPT-only: system says no transcript");
ok(pptMsgs[1].content.includes("=== TRANSCRIPT ===\n(none)"), "PPT-only: transcript section is (none)");

// ── assembleReport (transcript mode) ──
const report = assembleReport(null, bundle, llm, { pptOnly: false, generated_at: "2026-07-09T10:00:00Z" });
ok(report.meta.company === "Navin Fluorine International Ltd" && report.meta.ticker === "NAVINFLUOR" && report.meta.quarter === "Q4FY26", "meta passthrough from bundle");
ok(report.meta.inputs.cmp === 7689 && report.meta.inputs.net_debt_cr === 1272, "inputs passthrough from bundle");
ok(report.meta.sources.concall_date === "2026-05-01" && report.meta.transcript_available === true, "sources + transcript_available passthrough");
ok(report.about.sector === "Chemicals" && report.about.sub_sector === "Specialty & Fluorochemicals", "about sector/sub_sector from bundle (not re-derived)");
ok(report.about.products.length === 3 && report.about.segment_reported === false, "about products/segment_reported from LLM");
ok(report.about.revenue_mix[0].segment === "cGMP (CDMO)" && report.about.revenue_mix[0].pct === 35, "revenue_mix carried through");
// undisclosed-margin handling: stays null (schema-valid number|null), never a magic string
ok(report.about.margin_by_segment[0].ebitda_margin === 30, "disclosed margin kept as number");
ok(report.about.margin_by_segment[1].ebitda_margin === null, "undisclosed margin → null (schema-valid; renderer shows 'not disclosed', never invents a number)");

// ── source-tagging: every C.1/C.2 item is Transcript ──
ok(report.concall.guidance.every((g) => g.source === "Transcript") && report.concall.guidance.length === 3, "C.1 guidance all source=Transcript");
ok(report.concall.themes.every((t) => t.source === "Transcript"), "C.2 themes all source=Transcript");
ok(report.concall.guidance.filter((g) => g.type === "hard").length === 2, "guidance hard/directional split preserved");
ok(report.concall.tone_shift_vs_last_quarter.includes("More confident on CDMO"), "tone_shift carried");
ok(report.concall.classification[0].tag === "Operating leverage", "C.5 classification tag carried");
ok(report.concall.analyst_tone.hot_themes.length === 2 && report.concall.analyst_tone.qa_tenor === "constructive", "C.8 analyst tone carried");

// ── slices left for later steps ──
ok(Array.isArray(report.concall.risks) && report.concall.risks.length === 0, "C.6 risks left empty (Step 8)");
ok(report.key_takeaways.length === 0 && report.thesis.length === 0 && report.anti_thesis.length === 0, "key_takeaways/thesis/anti_thesis left empty (Steps 8–9)");

// ── PPT-only assembly tags source=PPT ──
const pptReport = assembleReport(null, { ...bundle, meta: { ...bundle.meta, transcript_available: false } }, llm, { pptOnly: true, generated_at: "2026-07-09T10:00:00Z" });
ok(pptReport.concall.guidance.every((g) => g.source === "PPT") && pptReport.concall.themes.every((t) => t.source === "PPT"), "PPT-only: C sources tagged PPT");

// ── validate B + C against report.schema.json ──
const v = validateBC(report, schema);
ok(v.ok, "B + C validate against report.schema.json" + (v.ok ? "" : " :: " + v.errors.slice(0, 3).join(" | ")));
ok(v.warnings.some((w) => /High Performance Products.*undisclosed/.test(w)), "validation warns (not errors) on the undisclosed margin");

// ── validator actually catches bad data (not a no-op) ──
const bad = assembleReport(null, bundle, llm, { pptOnly: false, generated_at: "z" });
bad.concall.themes[0].stance = "Bullish"; // not in enum
const vb = validateBC(bad, schema);
ok(!vb.ok && vb.errors.some((e) => /stance/.test(e) && /not in/.test(e)), "validator rejects an out-of-enum stance");
const bad2 = assembleReport(null, bundle, llm, { pptOnly: false, generated_at: "z" });
delete bad2.concall.analyst_tone.qa_tenor;
ok(!validateBC(bad2, schema).ok, "validator rejects a missing required field");

console.log(fails === 0 ? "\nEXTRACT (Step 7) OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
