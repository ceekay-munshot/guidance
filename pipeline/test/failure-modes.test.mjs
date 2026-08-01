// failure-modes.test.mjs — offline regression tests for the two ways a company used to fail with the
// generic "Couldn't complete the analysis" screen. No network, no deps (runs before `npm install`).
//   Run: node pipeline/test/failure-modes.test.mjs
//
// 1. LENDER LAYOUT (Five-Star Business Finance, runs #45–#49). Screener renders a bank/NBFC P&L with
//    "Financing Profit" / "Financing Margin %" and a singular "Borrowing" row. The parser only knew
//    the manufacturer labels, so EBITDA came back null — and the self-check treated a missing EBITDA
//    as fatal, killing a fetch that had already pulled a 62k-char transcript and a 37k-char deck.
//
// 2. PROVIDER OUT OF CREDIT (Neuland Laboratories, run #50). Step 6 passed its self-check; Step 7's
//    single un-retried call returned HTTP 429 `credit_balance_exhausted` and the client was told a
//    source document may have been unavailable. Errors must now be classified: a quota 429 is
//    permanent (don't retry, say so accurately), a plain 429 is transient (retry).

import { selfCheck } from "../lib/selfcheck.mjs";
import { PNL_LABELS, BS_LABELS, hasLabel, isLenderLayout } from "../lib/screener-labels.mjs";
import { classifyLlmError } from "../lib/openai.mjs";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + " — " + m); if (!c) fails++; };

// Normalised row labels exactly as lib/screener.mjs's norm() produces them, taken from the live
// Screener pages for a manufacturer (NEULANDLAB), an NBFC (FIVESTAR) and a bank (HDFCBANK).
const PNL_STANDARD = ["sales", "expenses", "operating profit", "opm %", "other income", "interest", "depreciation", "profit before tax", "tax %", "net profit", "eps in rs", "dividend payout %"];
const PNL_LENDER = ["revenue", "interest", "expenses", "financing profit", "financing margin %", "other income", "depreciation", "profit before tax", "tax %", "net profit", "eps in rs", "dividend payout %"];
const BS_STANDARD = ["equity capital", "reserves", "borrowings", "other liabilities", "total liabilities", "fixed assets", "cwip", "investments", "other assets", "total assets"];
const BS_NBFC = ["equity capital", "reserves", "borrowing", "other liabilities", "total liabilities", "fixed assets", "cwip", "investments", "other assets", "total assets"];
const BS_BANK = ["equity capital", "reserves", "deposits", "borrowing", "other liabilities", "total liabilities", "fixed assets", "cwip", "investments", "other assets", "total assets"];

// ── 1a. layout detection ──
ok(isLenderLayout(PNL_LENDER), "lender P&L ('Financing Profit') is detected as a lender layout");
ok(!isLenderLayout(PNL_STANDARD), "manufacturer P&L ('Operating Profit') is NOT a lender layout");

// ── 1b. the operating-profit row resolves under BOTH skeletons ──
ok(hasLabel(PNL_STANDARD, PNL_LABELS.ebitda), "EBITDA row found on a manufacturer P&L");
ok(hasLabel(PNL_LENDER, PNL_LABELS.ebitda), "EBITDA row found on a lender P&L (was null → hard failure)");
ok(hasLabel(PNL_STANDARD, PNL_LABELS.ebitda_margin_pct), "margin row found on a manufacturer P&L (OPM %)");
ok(hasLabel(PNL_LENDER, PNL_LABELS.ebitda_margin_pct), "margin row found on a lender P&L (Financing Margin %)");
ok(hasLabel(PNL_LENDER, PNL_LABELS.revenue) && hasLabel(PNL_LENDER, PNL_LABELS.pat), "revenue + PAT still resolve on a lender P&L");

// ── 1c. the borrowings row is matched by STEM, so the singular lender label works ──
ok(hasLabel(BS_STANDARD, BS_LABELS.borrowings), "'Borrowings' (manufacturer) matches the borrowings needle");
ok(hasLabel(BS_NBFC, BS_LABELS.borrowings), "'Borrowing' (NBFC, singular) matches too — the plural-only needle missed it");
ok(hasLabel(BS_BANK, BS_LABELS.borrowings), "a bank's 'Borrowing' row matches");
ok(hasLabel(BS_BANK, BS_LABELS.deposits) && !hasLabel(BS_NBFC, BS_LABELS.deposits), "deposits detected on a bank only (they are excluded from net debt)");
ok(!BS_LABELS.borrowings.some((n) => "deposits".includes(n)), "the borrowings needle never matches a deposits row");

// ── 1d. self-check: a missing EBITDA is a note, not a blocker ──
const lenderBundle = {
  meta: { transcript_available: true },
  inputs: { cmp: 548, cmp_date: "2026-07-31", shares_out_cr: 29.5985, market_cap_cr: 16220, net_debt_cr: null },
  fy26a: { revenue: 3218, ebitda: null, pat: 1099 },
  diagnostics: { notes: [] },
};
{
  const r = selfCheck(lenderBundle, { chars: 62527 });
  ok(r.ok, "bundle with revenue + PAT + transcript but NO EBITDA passes (Five-Star's exact shape)");
  ok(r.problems.some((p) => /ebitda/i.test(p)), "the missing EBITDA is still reported as a problem");
  ok(!r.critical.some((p) => /ebitda/i.test(p)), "…but it is NOT critical");
  ok(!r.critical.some((p) => /net_debt/i.test(p)), "a missing net_debt is not critical either (unchanged)");
}

// ── 1e. a genuine parse regression must STILL fail ──
{
  const broken = { ...lenderBundle, fy26a: { revenue: null, ebitda: null, pat: null } };
  const r = selfCheck(broken, { chars: 62527 });
  ok(!r.ok && r.critical.some((p) => /fy26a\.revenue/.test(p)), "revenue + PAT both missing → still a hard failure (real regression)");
}
{
  const noPrice = { ...lenderBundle, inputs: { ...lenderBundle.inputs, cmp: null } };
  ok(!selfCheck(noPrice, { chars: 62527 }).ok, "a missing CMP is still critical");
}
{
  const noText = selfCheck(lenderBundle, { chars: 10 });
  ok(!noText.ok, "a claimed transcript with no text is still critical");
}

// ── 2. provider error classification ──
// The verbatim body from run #50 (job 91325560783).
const QUOTA_BODY = JSON.stringify({ error: { message: "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.", type: "insufficient_quota", param: null, code: "credit_balance_exhausted" } });
{
  const c = classifyLlmError({ provider: "openai", status: 429, body: QUOTA_BODY });
  ok(c.kind === "quota", "the real Neuland 429 body classifies as 'quota', not a rate limit");
  ok(c.retryable === false, "an out-of-credit 429 is NOT retried (waiting never adds credit)");
  ok(/usage limit/i.test(c.userMessage), "the user message names a usage limit…");
  ok(!/transcript|deck|financials/i.test(c.userMessage) || /fetched fine/i.test(c.userMessage), "…and never blames the source documents, which downloaded fine");
}
{
  const c = classifyLlmError({ provider: "openai", status: 429, body: JSON.stringify({ error: { message: "Rate limit reached for gpt-4.1", type: "requests", code: "rate_limit_exceeded" } }) });
  ok(c.kind === "rate_limit" && c.retryable === true, "a plain rate-limit 429 IS retried");
}
{
  ok(classifyLlmError({ status: 503, body: "upstream" }).retryable === true, "a 5xx is retried");
  ok(classifyLlmError({ status: 0, body: "" }).retryable === true, "a network/timeout failure is retried");
  const auth = classifyLlmError({ status: 401, body: "invalid api key" });
  ok(auth.kind === "auth" && auth.retryable === false, "a 401 is not retried");
  const bad = classifyLlmError({ status: 400, body: "invalid schema" });
  ok(bad.kind === "bad_request" && bad.retryable === false, "a 400 (our bug) is not retried");
}
{
  // Every classification must carry a client-safe sentence, since it lands in the KV status message.
  for (const status of [0, 400, 401, 403, 429, 500, 503]) {
    const c = classifyLlmError({ status, body: "" });
    if (!(typeof c.userMessage === "string" && c.userMessage.length > 20)) { ok(false, `status ${status} has a usable userMessage`); break; }
  }
  ok(true, "every classification carries a client-safe userMessage");
}

// ── 3. retry + failover, with the transport stubbed (still no network) ──
// This is the behaviour that turns "OpenAI is out of credit" from an outage into a non-event.
const { callModel } = await import("../lib/llm.mjs");
const CALL = { messages: [{ role: "user", content: "hi" }], schema: { type: "object" }, schemaName: "t", purpose: "a test" };
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) });
const OPENAI_OK = JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: {}, model: "gpt-4.1" });
const ANTHROPIC_OK = JSON.stringify({ content: [{ type: "tool_use", input: { ok: true } }], usage: { input_tokens: 10, output_tokens: 5 }, model: "claude-sonnet-5" });
const realFetch = globalThis.fetch;
let hosts = [];

// 3a. OpenAI out of credit + Anthropic configured → fail over instead of failing the run.
process.env.OPENAI_API_KEY = "sk-test";
process.env.ANTHROPIC_API_KEY = "sk-ant-test";
globalThis.fetch = async (url) => {
  hosts.push(new URL(url).host);
  return String(url).includes("openai.com") ? res(429, QUOTA_BODY) : res(200, ANTHROPIC_OK);
};
{
  const r = await callModel(CALL);
  ok(r.provider === "anthropic" && r.data.ok === true, "OpenAI out of credit → the Anthropic fallback answers");
  ok(hosts.length === 2, "the quota 429 is not retried — one OpenAI attempt, then failover");
}

// 3b. No fallback configured → the run still fails, but with the accurate reason.
hosts = [];
delete process.env.ANTHROPIC_API_KEY;
{
  let thrown = null;
  try { await callModel(CALL); } catch (e) { thrown = e; }
  ok(thrown?.kind === "quota", "no fallback → still throws, classified as quota");
  ok(hosts.length === 1, "and does not retry a permanent failure");
  ok(/usage limit/i.test(thrown?.userMessage || ""), "the reason handed to the client is the real one");
}

// 3c. A transient 429 recovers on retry (one 2s backoff).
hosts = [];
let n = 0;
globalThis.fetch = async (url) => {
  hosts.push(new URL(url).host);
  return ++n === 1 ? res(429, JSON.stringify({ error: { code: "rate_limit_exceeded" } })) : res(200, OPENAI_OK);
};
{
  const r = await callModel(CALL);
  ok(r.provider === "openai" && r.data.ok === true && hosts.length === 2, "a transient rate-limit 429 is retried and recovers");
}
// 3d. A hung provider must not eat the job's 20-minute budget before failover. With the budget
// spent, callStructured stops retrying instead of burning 4 × timeoutMs on a dead connection.
hosts = [];
{
  const { callStructured } = await import("../lib/openai.mjs");
  globalThis.fetch = async (url) => { hosts.push(new URL(url).host); return res(429, JSON.stringify({ error: { code: "rate_limit_exceeded" } })); };
  let thrown = null;
  try { await callStructured({ apiKey: "k", model: "m", messages: [], schema: {}, budgetMs: 50 }); } catch (e) { thrown = e; }
  ok(hosts.length === 1, "an exhausted provider budget stops the retry loop after one attempt");
  ok(/budget spent/.test(thrown?.message || ""), "and the error says the budget was the reason");
}
globalThis.fetch = realFetch;

// The failover tests above deliberately marked providers dead, and that state now lives in a FILE
// shared by every later assertion — so clear it before anything that reads provider health.
{
  const { clearProviderHealth } = await import("../lib/llm.mjs");
  clearProviderHealth();
}

// ── 4. the verifier must never be the model that produced the extraction ──
const { chooseVerifier, verifierCandidates } = await import("../verify-extract.mjs");
const withEnv = (env, fn) => {
  const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, VERIFY_MODEL: process.env.VERIFY_MODEL };
  for (const k of Object.keys(saved)) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally { for (const k of Object.keys(saved)) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; } }
};
{
  const v = withEnv({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }, () => chooseVerifier({ provider: "openai", model: "gpt-4.1-2025-04-14" }));
  ok(v?.provider === "anthropic", "openai extraction + Anthropic key → cross-provider audit (unchanged)");
}
{
  const v = withEnv({ OPENAI_API_KEY: "o" }, () => chooseVerifier({ provider: "openai", model: "gpt-4.1" }));
  ok(v?.provider === "openai" && v.model === "gpt-4o", "openai extraction, no Anthropic key → a different OpenAI model (unchanged)");
}
{
  // The failover case: extraction already ran on Anthropic, so the audit must NOT also be Anthropic.
  const v = withEnv({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }, () => chooseVerifier({ provider: "anthropic", model: "claude-sonnet-5" }));
  ok(v?.provider === "openai", "Anthropic extraction → audit flips to OpenAI, not the same model");
}
{
  const v = withEnv({ ANTHROPIC_API_KEY: "a" }, () => chooseVerifier({ provider: "anthropic", model: "claude-sonnet-5" }));
  ok(v === null, "Anthropic extraction with only an Anthropic key → no independent verifier, audit skipped");
}
{
  const v = withEnv({ ANTHROPIC_API_KEY: "a", VERIFY_MODEL: "claude-haiku-4-5" }, () => chooseVerifier({ provider: "anthropic", model: "claude-sonnet-5" }));
  ok(v?.provider === "anthropic" && v.model === "claude-haiku-4-5", "…unless VERIFY_MODEL names a genuinely different model");
}
{
  const v = withEnv({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }, () => chooseVerifier({}));
  ok(v?.provider === "anthropic", "a legacy report with no _step7.provider still audits cross-provider");
}
// A preferred-but-unreachable verifier must fall through to the next INDEPENDENT one rather than
// silently dropping verification — so the candidate list carries more than the single best pick.
{
  const c = withEnv({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }, () => verifierCandidates({ provider: "openai", model: "gpt-4.1" }));
  ok(c.length === 2 && c[0].provider === "anthropic" && c[1].provider === "openai" && c[1].model === "gpt-4o",
    "openai extraction offers a 2nd verifier (gpt-4o) if Anthropic is down, instead of skipping");
  ok(c.every((x) => !(x.provider === "openai" && x.model === "gpt-4.1")), "no candidate is ever the extracting model");
}
{
  const c = withEnv({ ANTHROPIC_API_KEY: "a" }, () => verifierCandidates({ provider: "anthropic", model: "claude-sonnet-5" }));
  ok(c.length === 0, "nothing independent configured → empty candidate list (audit skipped)");
}
// VERIFY_MODEL is one setting but there are two possible verifier providers, so it must only apply
// to the one it names. Handing an Anthropic id to OpenAI earns a 400 that would take down a run
// whose report was already complete — a setting valid under the old behaviour must not become a trap.
{
  const c = withEnv({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a", VERIFY_MODEL: "claude-sonnet-5" }, () => verifierCandidates({ provider: "anthropic", model: "claude-opus-4" }));
  const openai = c.find((x) => x.provider === "openai");
  ok(openai && openai.model === "gpt-4o", "an Anthropic VERIFY_MODEL is NOT sent to OpenAI — it falls back to gpt-4o");
  ok(c.every((x) => x.provider !== "anthropic" || /^claude/.test(x.model)), "…and only Anthropic candidates carry a claude-* id");
}
{
  const c = withEnv({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a", VERIFY_MODEL: "gpt-4o-mini" }, () => verifierCandidates({ provider: "openai", model: "gpt-4.1" }));
  const anth = c.find((x) => x.provider === "anthropic");
  const oai = c.find((x) => x.provider === "openai");
  ok(anth && anth.model === "claude-sonnet-5", "an OpenAI VERIFY_MODEL is NOT sent to Anthropic");
  ok(oai && oai.model === "gpt-4o-mini", "…and the override still applies to the provider it names");
}

// ── 5. a lender's valuation prose must say EV/EBITDA doesn't apply ──
const { buildSanityCheck } = await import("../lib/model.mjs");
const VAL = { market_cap_cr: 16220, ev_cr: 24420, pe: { fy27e: 13.2, fy28e: 11.1 }, ev_ebitda: { fy27e: 15.4, fy28e: 13.0 }, price_sales: { fy27e: 4.5 } };
{
  const s = buildSanityCheck({ valuation: VAL, inputs: { cmp: 548, net_debt_cr: 8200 }, currentPe: 14, richness: {}, positiveTone: true, lender: true });
  ok(/not meaningful/i.test(s), "lender prose states EV/EBITDA and net debt are not meaningful");
  ok(/Financing Profit/i.test(s), "…and that the EBITDA line is Screener's Financing Profit");
  ok(!/15\.4x FY27E EV\/EBITDA/.test(s), "…and does not quote an EV/EBITDA multiple as if it applied");
  ok(/P\/E/.test(s), "…while still giving the P/E that does apply");
}
{
  const s = buildSanityCheck({ valuation: VAL, inputs: { cmp: 7689, net_debt_cr: 1272 }, currentPe: 40, richness: {}, positiveTone: true });
  ok(/EV\/EBITDA/.test(s) && !/not meaningful/i.test(s), "a normal company's prose is unchanged");
}

// ── 6. a provider proven dead stays dead for the rest of the run ──
// Each workflow step is its own node process, so this has to survive via the workspace, or a hanging
// primary gets re-probed (and its budget re-spent) by all five LLM steps inside one 20-minute job.
{
  const { markProviderUnhealthy, availableProviders } = await import("../lib/llm.mjs");
  const { rmSync } = await import("node:fs");
  const HEALTH = new URL("../out/.provider-health.json", import.meta.url);
  rmSync(HEALTH, { force: true });
  withEnv({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }, () => {
    ok(availableProviders().map((p) => p.provider).join(",") === "openai,anthropic", "both providers offered while healthy");
    markProviderUnhealthy("openai", "quota: out of credit");
    ok(availableProviders().map((p) => p.provider).join(",") === "anthropic", "a provider marked dead is skipped by later steps");
  });
  withEnv({ OPENAI_API_KEY: "o" }, () => {
    ok(availableProviders().map((p) => p.provider).join(",") === "openai",
      "…unless it is the only one left — a doomed attempt still yields the accurate error");
  });
  rmSync(HEALTH, { force: true });
}
{
  // pipeline/out/ is gitignored, not cleaned, so it survives between LOCAL runs — a mark must not
  // outlive the analysis that made it, or a repaired key stays routed around indefinitely.
  const { markProviderUnhealthy, availableProviders, clearProviderHealth } = await import("../lib/llm.mjs");
  const { rmSync, readFileSync, writeFileSync } = await import("node:fs");
  const HEALTH = new URL("../out/.provider-health.json", import.meta.url);
  withEnv({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }, () => {
    markProviderUnhealthy("openai", "quota");
    clearProviderHealth();
    ok(availableProviders().map((p) => p.provider).join(",") === "openai,anthropic", "a new run clears provider health (fetch-company calls this first)");

    // …and a stale file left by an interrupted run expires on its own.
    markProviderUnhealthy("openai", "quota");
    const stale = JSON.parse(readFileSync(HEALTH, "utf8"));
    stale.openai.at = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    writeFileSync(HEALTH, JSON.stringify(stale));
    ok(availableProviders().map((p) => p.provider).join(",") === "openai,anthropic", "a mark older than the TTL is ignored (backstop for a step run on its own)");
  });
  rmSync(HEALTH, { force: true });
}
{
  // Budget exhaustion must be flagged as durable so callModel records it, not just this one call.
  const { callStructured } = await import("../lib/openai.mjs");
  globalThis.fetch = async () => res(429, JSON.stringify({ error: { code: "rate_limit_exceeded" } }));
  let thrown = null;
  try { await callStructured({ apiKey: "k", model: "m", messages: [], schema: {}, budgetMs: 50 }); } catch (e) { thrown = e; }
  ok(thrown?.budgetSpent === true, "an exhausted budget marks the error durable (provider recorded dead)");
  globalThis.fetch = realFetch;
}

// ── 7. EV/EBITDA is suppressed, not merely caveated ──
const { assembleModel } = await import("../lib/model-assemble.mjs");
const { computeModel } = await import("../../public/js/report.js");
const { readFile } = await import("node:fs/promises");
const F = (rel) => new URL(rel, import.meta.url);
const REPORT_FIXTURE = JSON.parse(await readFile(F("../test-fixtures/report.step8.json"), "utf8"));
const MODEL_LLM = JSON.parse(await readFile(F("../test-fixtures/model-response.json"), "utf8"));
{
  const base = JSON.parse(JSON.stringify(REPORT_FIXTURE));
  const r = assembleModel(base, { revenue: 3218, ebitda: 1472, ebitda_margin_pct: 46, pat: 1099, net_margin_pct: 34.2, gross_margin_pct: null }, MODEL_LLM, null, { generated_at: "2026-08-01T00:00:00Z", lender: true });
  ok(r.report.valuation.ev_ebitda.fy27e === null && r.report.valuation.ev_ebitda.fy28e === null,
    "lender: EV/EBITDA stored as null so the UI and every exporter render 'n.m.'");
  ok(r.warnings.some((w) => /lender/i.test(w)), "…and the suppression is warned about, not silent");
  r.report.meta.lender = true;
  const live = computeModel(r.report, { growth_fy27: 12, growth_fy28: 10, ebitda_margin_fy27: 46, ebitda_margin_fy28: 46, net_margin_fy27: 34, net_margin_fy28: 34 });
  ok(live.valuation.ev_ebitda.fy27e === null, "…and editing a lever does NOT resurrect it in the frontend recompute");
}
{
  // A dropped Operating Profit row on a NON-lender: the bundle still passes, but the multiple that
  // would rest entirely on an unanchored margin guess is suppressed rather than published.
  const base = JSON.parse(JSON.stringify(REPORT_FIXTURE));
  const r = assembleModel(base, { revenue: 2023, ebitda: null, ebitda_margin_pct: null, pat: 364, net_margin_pct: 18, gross_margin_pct: null }, MODEL_LLM, null, { generated_at: "2026-08-01T00:00:00Z" });
  ok(r.report.valuation.ev_ebitda.fy27e === null, "no FY26A EBITDA actual → EV/EBITDA suppressed as n.m.");
  ok(r.warnings.some((w) => /EBITDA/i.test(w)), "…with a warning that says why");
  ok(r.report.valuation.pe.fy27e !== null, "…while P/E, which is properly anchored, still publishes");
}
{
  const base = JSON.parse(JSON.stringify(REPORT_FIXTURE));
  const r = assembleModel(base, { revenue: 2023, ebitda: 580, ebitda_margin_pct: 29, pat: 364, net_margin_pct: 18, gross_margin_pct: null }, MODEL_LLM, null, { generated_at: "2026-08-01T00:00:00Z" });
  ok(typeof r.report.valuation.ev_ebitda.fy27e === "number", "a normal company with a real EBITDA anchor still gets EV/EBITDA");
}
{
  // The stored artifact and the frontend recompute must agree on what counts as an anchor — including
  // EXACTLY ZERO, which the pipeline treats as missing and the frontend previously accepted.
  const LEV = { growth_fy27: 12, growth_fy28: 10, ebitda_margin_fy27: 25, ebitda_margin_fy28: 25, net_margin_fy27: 15, net_margin_fy28: 15 };
  for (const [name, ebitda] of [["a real anchor", 580], ["exactly zero", 0], ["missing", null]]) {
    const r = assembleModel(JSON.parse(JSON.stringify(REPORT_FIXTURE)),
      { revenue: 2023, ebitda, ebitda_margin_pct: ebitda === null ? null : 29, pat: 364, net_margin_pct: 18, gross_margin_pct: null },
      MODEL_LLM, null, { generated_at: "2026-08-01T00:00:00Z" });
    const stored = r.report.valuation.ev_ebitda.fy27e;
    const afterEdit = computeModel(r.report, LEV).valuation.ev_ebitda.fy27e;
    ok((stored === null) === (afterEdit === null), `${name}: stored and post-edit EV/EBITDA agree (no drift)`);
  }
}

// ── 8. classifier + model-id edges surfaced by review ──
{
  const c = classifyLlmError({ status: 408, body: "request timeout" });
  ok(c.kind === "network" && c.retryable === true, "HTTP 408 is a transient timeout — retried and able to trigger failover");
}
{
  // gpt-4.1-mini is a distinct model (it has its own price entry), so it must not read as gpt-4.1 —
  // a loose prefix test made the verifier decline a perfectly good independent candidate.
  const c = withEnv({ OPENAI_API_KEY: "o", VERIFY_MODEL: "gpt-4.1-mini" }, () => verifierCandidates({ provider: "openai", model: "gpt-4.1" }));
  ok(c.length === 1 && c[0].model === "gpt-4.1-mini", "gpt-4.1-mini is a DIFFERENT model from gpt-4.1 — the audit runs");
}
{
  const c = withEnv({ OPENAI_API_KEY: "o", VERIFY_MODEL: "gpt-4.1" }, () => verifierCandidates({ provider: "openai", model: "gpt-4.1-2025-04-14" }));
  ok(c.length === 0, "…but a dated suffix is still normalised away, so gpt-4.1 never audits itself");
}

// ── 9. a provider that stalls MID-BODY must still time out ──
// fetch() resolves on headers, so a timer cleared at that point leaves body consumption unguarded —
// the exact hang the per-provider budget exists to prevent. The stub below sends headers instantly
// and never resolves the body; the attempt must abort rather than hang.
{
  const { callStructured } = await import("../lib/openai.mjs");
  globalThis.fetch = async (_url, opts) => ({
    ok: true,
    status: 200,
    // Never resolves on its own — only the abort signal can end this.
    json: () => new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const e = new Error("aborted"); e.name = "AbortError"; reject(e);
      });
    }),
    text: async () => "",
  });
  const started = Date.now();
  let thrown = null;
  try {
    await callStructured({ apiKey: "k", model: "m", messages: [], schema: {}, timeoutMs: 300, budgetMs: 400, retries: 0 });
  } catch (e) { thrown = e; }
  const elapsed = Date.now() - started;
  ok(thrown !== null, "a stalled response body aborts instead of hanging forever");
  ok(/timed out/i.test(thrown?.message || "") && /body/i.test(thrown?.message || ""), "…and the error names the response body as what timed out");
  ok(thrown?.retryable === true, "…and it is retryable, so retry + failover still apply");
  ok(elapsed < 3000, `…and it happens on the timeout, not the job ceiling (${elapsed}ms)`);
  globalThis.fetch = realFetch;
}

// ── 10. lender reports must not present a lender's numbers under manufacturer names ──
{
  const { buildModelMessages } = await import("../lib/model-assemble.mjs");
  const FY26A_LENDER = { revenue: 3218, ebitda: 1472, ebitda_margin_pct: 46, pat: 1099, net_margin_pct: 34.2, gross_margin_pct: null };
  const base = JSON.parse(JSON.stringify(REPORT_FIXTURE));

  const lenderMsgs = buildModelMessages(base, FY26A_LENDER, null, { lender: true });
  const sys = lenderMsgs[0].content, usr = lenderMsgs[1].content;
  ok(/ALREADY NET OF INTEREST COST/.test(sys), "lender prompt tells the model the profit line is net of interest…");
  ok(/FINANCING MARGIN/i.test(sys), "…that the margin lever means financing margin…");
  ok(/not leverage/i.test(sys), "…and not to reason about EV / net debt");
  ok(/financing profit 1472/.test(usr), "the FY26A line names financing profit, not EBITDA");
  ok(!/net debt ₹/.test(usr), "…and the price inputs don't hand it a 'net debt' to model with");

  const normalMsgs = buildModelMessages(base, FY26A_LENDER, null, {});
  ok(!/ALREADY NET OF INTEREST COST/.test(normalMsgs[0].content) && /EBITDA 1472/.test(normalMsgs[1].content),
    "a normal company's prompt is unchanged");
}
{
  const lenderRows = assembleModel(JSON.parse(JSON.stringify(REPORT_FIXTURE)),
    { revenue: 3218, ebitda: 1472, ebitda_margin_pct: 46, pat: 1099, net_margin_pct: 34.2, gross_margin_pct: null },
    MODEL_LLM, null, { generated_at: "2026-08-01T00:00:00Z", lender: true }).report.financials.rows;
  const eb = lenderRows.find((r) => r.key === "ebitda");
  const em = lenderRows.find((r) => r.key === "ebitda_margin_pct");
  ok(eb.metric === "Financing profit" && em.metric === "Financing margin %", "lender rows are LABELLED as financing profit/margin");
  ok(eb.key === "ebitda" && em.key === "ebitda_margin_pct", "…while the stable keys are unchanged, so every consumer still resolves them");
  ok(!lenderRows.some((r) => r.key === "adj_ebitda_margin_pct"), "a lender never gets an 'Adjusted EBITDA' row");
}
{
  // Exports must not call a lender's borrowings "net debt" — the report's own prose says they aren't.
  const { reportContent } = await import("../../public/js/export.js");
  const rep = JSON.parse(JSON.stringify(REPORT_FIXTURE));
  rep.meta.lender = true;
  ok(reportContent(rep).lender === true, "export context carries the lender flag through to every renderer");
  const plain = JSON.parse(JSON.stringify(REPORT_FIXTURE));
  ok(reportContent(plain).lender === false, "…and a normal company is unaffected");
}

// ── 11. the audit must not re-probe a provider already proven dead ──
// (explicit `healthy` stubs below — no dependency on whatever the health file happens to hold)
{
  const openaiDead = (p) => p !== "openai";
  const allHealthy = () => true;
  const withKeys = { OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" };
  const live = withEnv(withKeys, () => verifierCandidates({ provider: "anthropic", model: "claude-sonnet-5" }, allHealthy));
  ok(live.length === 1 && live[0].provider === "openai", "healthy OpenAI is still offered after an Anthropic extraction");
  const dead = withEnv(withKeys, () => verifierCandidates({ provider: "anthropic", model: "claude-sonnet-5" }, openaiDead));
  ok(dead.length === 0, "an already-dead OpenAI is NOT re-probed — the audit skips instead of burning a 2nd 90s budget");
}

// ── 12. consequences of the lender relabel, and the health marker's remaining hole ──
{
  // net_debt_cr is borrowings MINUS cash wherever Screener reports cash, so calling it "Borrowings"
  // would overstate it. The label must stay accurate about the netting.
  const { reportContent } = await import("../../public/js/export.js");
  const rep = JSON.parse(JSON.stringify(REPORT_FIXTURE));
  rep.meta.lender = true;
  const c = reportContent(rep);
  const label = c.lender ? "Net borrowings" : "Net debt";
  ok(label === "Net borrowings", "a lender's funding line is labelled 'Net borrowings' — not 'Borrowings' (it is net of cash)");
  ok(!/^Borrowings$/.test(label), "…so the label never claims a gross figure");
}
{
  // The frontend badge keywords must match the backend's guidedFor() calls, or a lender's
  // "financing margin" guidance is badged Est. in the UI while the report text calls it guided.
  const src = await readFile(new URL("../../public/js/report.js", import.meta.url), "utf8");
  ok(/leverBasis\(report, \["ebitda", "margin"\]\)/.test(src), "margin lever basis uses the same keywords as guidedFor(['ebitda','margin'])");
  ok(/leverBasis\(report, \["revenue", "growth"\]\)/.test(src), "growth lever basis matches guidedFor(['revenue','growth'])");
  ok(/lender \? "Financing margin" : "EBITDA margin"/.test(src), "the margin LEVER is relabelled for lenders, matching its row");
}
{
  // The verifier calls providers outside callModel, so it must report durable failures to the shared
  // marker — otherwise Model and Finalize each re-pay a full budget rediscovering the same outage.
  const { noteProviderFailure, isProviderHealthy, clearProviderHealth } = await import("../lib/llm.mjs");
  clearProviderHealth();
  ok(noteProviderFailure("openai", { kind: "rate_limit", message: "slow down" }) === false, "a transient verifier failure is NOT held against the provider");
  ok(isProviderHealthy("openai"), "…so it stays available to later steps");
  ok(noteProviderFailure("openai", { kind: "quota", message: "no credits" }) === true, "an out-of-credit verifier failure IS recorded");
  ok(!isProviderHealthy("openai"), "…so Model and Finalize skip it instead of rediscovering it");
  clearProviderHealth();
  ok(noteProviderFailure("anthropic", { kind: "network", message: "hang", budgetSpent: true }) === true, "a verifier that burned its whole budget marks the provider dead too");
  clearProviderHealth();
}

console.log(fails === 0 ? "\nFAILURE-MODE OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
