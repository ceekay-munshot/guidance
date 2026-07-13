// provenance.test.mjs — offline unit tests for the source-traceability helpers (no DOM).
// Run: node worker/test/provenance.test.mjs

import { readFile } from "node:fs/promises";
import {
  resolveSourceUrl, isPdfUrl, textFragment, buildSourceLink, collectWebSources, hostOf,
} from "../../public/js/provenance.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };

const meta = { sources: { transcript_url: "https://x.com/t.pdf", ppt_url: "https://x.com/deck.pdf", concall_date: "2026-05-06" } };

// ── resolveSourceUrl ──
ok(resolveSourceUrl("Transcript", {}, meta) === "https://x.com/t.pdf", "Transcript → transcript_url");
ok(resolveSourceUrl("PPT", {}, meta) === "https://x.com/deck.pdf", "PPT → ppt_url");
ok(resolveSourceUrl("Web", { source_url: "https://news.com/a" }, meta) === "https://news.com/a", "Web → fact.source_url");
ok(resolveSourceUrl("Web", {}, meta) === null, "Web with no url → null");
ok(resolveSourceUrl("Est.", {}, meta) === null, "Est. → null (no linkable source)");

// ── isPdfUrl ──
ok(isPdfUrl("https://x.com/t.pdf") === true && isPdfUrl("https://x.com/t.pdf?x=1") === true, "isPdfUrl: .pdf and .pdf?query");
ok(isPdfUrl("https://news.com/article") === false, "isPdfUrl: html → false");
ok(isPdfUrl(null) === false, "isPdfUrl: null → false");

// ── textFragment ──
ok(textFragment("bottoming not yet") === "#:~:text=bottoming%20not%20yet", "short quote → whole-string fragment");
const longFrag = textFragment("one two three four five six seven eight nine ten");
ok(/^#:~:text=one%20two%20three%20four%20five,six%20seven%20eight%20nine%20ten$/.test(longFrag), "long quote → start,end range fragment");
ok(textFragment("a-b, c").includes("%2D") && textFragment("a-b, c").includes("%2C"), "delimiters (hyphen/comma) percent-encoded");
ok(textFragment("") === "" && textFragment(null) === "", "empty/null → no fragment");

// ── buildSourceLink ──
const web = buildSourceLink({ source: "Web", source_url: "https://news.com/a", quote: "pricing pressure over FY27-28 is real" }, meta);
ok(web.kind === "html" && web.href.startsWith("https://news.com/a#:~:text=") && web.canDeepLink, "Web+quote → html scroll-to-text link");
const tr = buildSourceLink({ source: "Transcript", quote: "we target 20 percent plus CAGR" }, meta);
ok(tr.kind === "pdf" && tr.href === "https://x.com/t.pdf" && !tr.canDeepLink, "Transcript(PDF) → open URL, no deep link (Ctrl+F workflow)");
ok(tr.quote === "we target 20 percent plus CAGR", "Transcript link keeps the verbatim quote for copy/Ctrl+F");
const anchor = buildSourceLink({ source: "Transcript", anchor: "strongest in our history" }, meta);
ok(anchor.quote === "strongest in our history", "quote falls back to anchor (management-tone items)");
const est = buildSourceLink({ source: "Est." }, meta);
ok(est.kind === "none" && est.href === null, "Est. → no linkable source");

// ── collectWebSources + hostOf (against the real sample report) ──
ok(hostOf("https://www.bseindia.com/x/y.pdf") === "bseindia.com", "hostOf strips scheme + www");
const sample = JSON.parse(await readFile(new URL("../../public/data/sample-report.json", import.meta.url), "utf8"));
const web5 = collectWebSources(sample);
ok(web5.length >= 3 && web5.every((w) => w.url && w.title), "collectWebSources: dedup list from meta.sources.web + fact urls");

console.log(fails === 0 ? "\nPROVENANCE (source traceability) OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
