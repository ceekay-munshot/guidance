// extract.test.mjs — offline unit tests for Step 7 (no OpenAI, no deps). Run: node pipeline/test/extract.test.mjs
// Uses committed fixtures + a canned LLM response to verify prompt-building, assembly, source-tagging,
// the transcript-only-for-C rule, the PPT-only path, "not disclosed" preservation, and B+C validation.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildMessages, assembleReport, validateBC, verifyQuotes, normForMatch } from "../lib/extract-assemble.mjs";
import { shouldDegradeToPpt } from "../lib/fetchers.mjs";

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

// ── provenance: verbatim quotes carried through + verified against the source ──
ok(report.concall.guidance.every((g) => "quote" in g), "assembly carries a `quote` slot on every guidance item");
ok(report.concall.themes.every((t) => "quote" in t) && report.concall.thesis_triggers.every((t) => "quote" in t), "themes + thesis_triggers carry a `quote` slot");
ok(buildMessages(bundle, transcript, "").find((m) => m.role === "system").content.includes("Ctrl+F"), "prompt asks for a Ctrl+F-able verbatim quote");

// normForMatch: robust to case / punctuation / whitespace / smart-quotes
ok(normForMatch("  We  target 20%—plus, CAGR. ") === "we target 20 plus cagr", "normForMatch normalises punctuation/whitespace/dashes");

// verifyQuotes: keeps a quote found in the source, drops a paraphrase (guarantees Ctrl+F works)
{
  const src = "Management said: we expect blended EBITDA margins to move towards 25 percent in FY27. Thank you.";
  const rep = { concall: {
    guidance: [{ metric: "Margin", quote: "we expect blended EBITDA margins to move towards 25 percent in FY27" }],
    themes: [{ theme: "Made up", quote: "this sentence is nowhere in the transcript at all" }],
    thesis_triggers: [{ trigger: "T", quote: null }],
  } };
  const r = verifyQuotes(rep, src);
  ok(r.kept === 1 && r.dropped === 1, "verifyQuotes: 1 verified, 1 dropped");
  ok(rep.concall.guidance[0].quote && rep.concall.themes[0].quote === null, "verified quote kept; unfindable quote → null (never a fake Ctrl+F target)");
}
// a too-short quote can't anchor → dropped
ok(verifyQuotes({ concall: { guidance: [{ quote: "yes" }] } }, "yes indeed").report.concall.guidance[0].quote === null, "verifyQuotes: sub-12-char quote dropped (too weak to anchor)");

// ── PPT-only fallback: an un-fetchable transcript must not hard-fail a company with a good deck ──
ok(shouldDegradeToPpt(0, 5000) === true, "fallback: transcript fetch failed + usable PPT → degrade to PPT-only (no hard fail)");
ok(shouldDegradeToPpt(120, 21692) === true, "fallback: Sacheerome shape (empty transcript, 21k-char deck) → PPT-only");
ok(shouldDegradeToPpt(6000, 5000) === false, "fallback: good transcript → keep transcript (no degrade)");
ok(shouldDegradeToPpt(0, 200) === false, "fallback: no transcript AND no usable PPT → genuine fail (nothing to read)");

console.log(fails === 0 ? "\nEXTRACT (Step 7) OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
