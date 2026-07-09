// research.test.mjs — offline unit tests for Step 8 (no web, no LLM, no deps).
// Run: node pipeline/test/research.test.mjs
// Uses committed fixtures + canned web-search / risk-thesis / verifier responses to verify the
// C.6+D assembly, the "every D point has a non-empty falsifier" rule, and the verifier flagging
// logic (a planted hallucinated guidance item must be flagged, dropped, and logged).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildRiskThesisMessages, assembleResearch, validateResearch } from "../lib/research-assemble.mjs";
import { buildClaims, buildVerifyMessages, applyVerification } from "../lib/verify.mjs";

const F = (p) => fileURLToPath(new URL(p, import.meta.url));
const report = JSON.parse(await readFile(F("../test-fixtures/report.step7.json"), "utf8"));
const web = JSON.parse(await readFile(F("../test-fixtures/websearch.results.json"), "utf8"));
const researchLlm = JSON.parse(await readFile(F("../test-fixtures/research-response.json"), "utf8"));
const verifyLlm = JSON.parse(await readFile(F("../test-fixtures/verify-response.json"), "utf8"));
const schema = JSON.parse(await readFile(F("../../public/data/report.schema.json"), "utf8"));

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };

// ── buildRiskThesisMessages ──
const rtMsgs = buildRiskThesisMessages(report, web, {});
ok(rtMsgs.length === 2 && rtMsgs[0].role === "system" && rtMsgs[1].role === "user", "risk/thesis → [system, user]");
ok(/risks NOT volunteered on the call/i.test(rtMsgs[0].content), "system asks for OFF-CALL risks");
ok(rtMsgs[0].content.includes("(Source: <URL>)"), "system requires a real source URL in each risk");
ok(/EVERY point MUST carry a falsifier/i.test(rtMsgs[0].content), "system enforces a falsifier on every D point");
ok(rtMsgs[0].content.includes("Litigation") && rtMsgs[0].content.includes("Rating action"), "system lists the risk-type vocabulary");
ok(rtMsgs[1].content.includes("GST demand") && rtMsgs[1].content.includes("SOURCES:"), "user carries the web findings + their sources");

// ── assembleResearch: source-tagging + falsifier enforcement ──
const { report: merged, warnings, dropped } = assembleResearch(report, researchLlm, { generated_at: "2026-07-09T11:00:00Z" });
ok(merged.concall.risks.length === 2 && merged.concall.risks.every((r) => r.source === "Web"), "C.6 risks all source=Web");
ok(merged.concall.risks.every((r) => /\(Source: https?:\/\//.test(r.risk)), "every risk cites a real URL");
ok(merged.thesis.length === 3, "thesis: the empty-falsifier point was dropped (4 → 3)");
ok(merged.thesis.every((p) => p.falsifier && p.falsifier.trim().length > 0), "every surviving thesis point has a non-empty falsifier");
ok(merged.anti_thesis.length === 3 && merged.anti_thesis.every((p) => p.falsifier.trim()), "anti_thesis: 3 points, each falsifiable");
ok(merged.thesis.concat(merged.anti_thesis).every((p) => p.source === "Web" || p.source === "Est."), "every D point source is Web or Est.");
ok(dropped.length === 1 && dropped[0].section === "thesis", "the dropped point is recorded");
ok(warnings.some((w) => /no falsifier/.test(w)), "assembly warns about the dropped point");
// untouched slices survive
ok(merged.concall.guidance.length === 4 && merged.about.sector === "Chemicals", "Step-7 slices (about, concall) pass through untouched");

// ── validateResearch ──
const rv = validateResearch(merged, schema);
ok(rv.ok, "C.6 + D validate against report.schema.json" + (rv.ok ? "" : " :: " + rv.errors.slice(0, 3).join(" | ")));
// negative: an empty falsifier must be caught (schema can't express it; validateResearch does)
const badFals = JSON.parse(JSON.stringify(merged));
badFals.thesis[0].falsifier = "   ";
ok(!validateResearch(badFals, schema).ok, "validator rejects a blank falsifier");
// negative: a bad source enum must be caught by the schema pass
const badSrc = JSON.parse(JSON.stringify(merged));
badSrc.concall.risks[0].source = "Rumour";
ok(!validateResearch(badSrc, schema).ok, "validator rejects an out-of-enum risk source");

// ── buildClaims ──
const claims = buildClaims(report, { transcriptAvailable: true });
ok(claims.length === 10, "buildClaims → 10 transcript-sourced claims (4 guidance, 1 flag, 5 about)");
ok(claims.filter((c) => c.category === "guidance").length === 4, "all 4 guidance items are claimed");
ok(claims.find((c) => c.ref === "guidance[3]").claim.includes("Dividend"), "the planted dividend claim is included for audit");
// PPT-only (no transcript): transcript-sourced facts should not be audited against a transcript
const pptReport = JSON.parse(JSON.stringify(report));
pptReport.concall.guidance.forEach((g) => (g.source = "PPT"));
ok(buildClaims(pptReport, { transcriptAvailable: false }).length === 0, "PPT-only report → 0 transcript claims to audit");

// ── buildVerifyMessages ──
const vMsgs = buildVerifyMessages(report, "transcript text here", claims);
ok(vMsgs.length === 2 && /prefer "partial"/i.test(vMsgs[0].content), "verifier system biases toward 'partial' when unsure");
ok(vMsgs[1].content.includes("guidance[3]") && vMsgs[1].content.includes("=== TRANSCRIPT ==="), "verifier user carries the refs + transcript");

// ── applyVerification: the planted hallucination is dropped, logged; everything else kept ──
const { report: pruned, audit } = applyVerification(report, verifyLlm, { model: "gpt-4o", provider: "openai", transcriptAvailable: true });
ok(pruned.concall.guidance.length === 3, "guidance pruned 4 → 3 (the hallucinated dividend dropped)");
ok(!pruned.concall.guidance.some((g) => g.metric === "Dividend"), "the fabricated dividend guidance is gone");
ok(audit.dropped.length === 1 && audit.dropped[0].ref === "guidance[3]", "audit records exactly the dropped ref");
ok(audit.verdicts.find((v) => v.ref === "guidance[3]").dropped === true, "the dropped verdict is flagged dropped:true in the audit");
ok(audit.checked === 10 && audit.tally.unsupported === 1 && audit.tally.supported === 5, "audit tallies all 10 verdicts");
ok(pruned.about.revenue_mix.length === 3 && pruned.concall.expansion_flags.length === 1, "partial/low-confidence claims are KEPT (conservative drop)");
ok(report.concall.guidance.length === 4, "applyVerification did not mutate the input report");

console.log(fails === 0 ? "\nRESEARCH + VERIFY (Step 8) OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
