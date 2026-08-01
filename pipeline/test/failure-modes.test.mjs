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
globalThis.fetch = realFetch;

console.log(fails === 0 ? "\nFAILURE-MODE OFFLINE TESTS OK" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
