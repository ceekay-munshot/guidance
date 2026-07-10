#!/usr/bin/env node
// kv-put.mjs — STEP 10/11: publish pipeline results + progress to Cloudflare KV for the Worker.
// Called by fetch-company.yml:
//   node pipeline/kv-put.mjs progress <slug> <stage>   before each stage (cosmetic; best-effort)
//   node pipeline/kv-put.mjs report   <slug>           on success (publishes report + library index)
//   node pipeline/kv-put.mjs error    <slug> "message" on failure  (best-effort)
//
// Keys: status:<slug> = { state, stage?, updated_at, message? }; report:<slug> = the report JSON;
//       index:reports = [{ slug, company, ticker, sector, conviction, generated_at }] (library).
// FAILURE SEMANTICS: `report` is fail-loud (missing creds → non-zero: it is the ONLY path that turns
// the Worker's queued status into a visible report, so a green-but-silent finish would strand the
// client). `progress`/`error` are best-effort (cosmetic) and never abort the run. A blank slug
// (manual run) is a no-op everywhere.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { kvPut, kvConfigured } from "./lib/kv.mjs";
import { log } from "./lib/util.mjs";

const OUT_ROOT = fileURLToPath(new URL("./out/", import.meta.url));

async function findReportJson() {
  let entries = [];
  try { entries = await readdir(OUT_ROOT, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(OUT_ROOT, e.name, "report.json");
    try { await readFile(p, "utf8"); return p; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Write this run's library card under its OWN key (report-meta:<slug>) — no read-modify-write of a
 * shared array, so two DIFFERENT companies finishing at once can't clobber each other's entry (the
 * workflow concurrency group is per-slug, so cross-slug runs are concurrent). The Worker's
 * /api/reports lists these keys. Best-effort.
 */
async function writeLibraryCard(slug, rep) {
  const entry = {
    slug,
    company: rep.meta?.company || null,
    ticker: rep.meta?.ticker || null,
    sector: rep.about?.sector || null,
    conviction: rep.next_steps?.conviction || null,
    generated_at: rep.meta?.generated_at || null,
  };
  await kvPut(`report-meta:${slug}`, JSON.stringify(entry));
}

async function main() {
  const [cmd, slug, arg3, arg4] = process.argv.slice(2);
  if (!cmd) { log.err("usage: kv-put.mjs <progress|report|error> <slug> [stage|message]"); process.exitCode = 1; return; }
  if (!slug) { log.info(`kv-put ${cmd}: blank slug (manual run) — skipping KV`); return; } // no-op for manual runs

  const bestEffort = cmd === "progress" || cmd === "error";
  if (!kvConfigured()) {
    if (bestEffort) { log.warn(`CF KV not configured — skipping best-effort ${cmd} for "${slug}"`); return; }
    log.err(`CF KV not configured (need CF_ACCOUNT_ID / CF_KV_NAMESPACE_ID / CF_API_TOKEN) — cannot ${cmd} "${slug}". A live run requires the three Cloudflare Actions secrets.`);
    process.exitCode = 1; return;
  }

  try {
    if (cmd === "progress") {
      const stage = arg3 || "running";
      await kvPut(`status:${slug}`, JSON.stringify({ state: "running", stage, updated_at: new Date().toISOString() }));
      log.ok(`KV status:${slug} = running (${stage})`);
    } else if (cmd === "error") {
      await kvPut(`status:${slug}`, JSON.stringify({ state: "error", updated_at: new Date().toISOString(), message: arg4 || arg3 || "Analysis failed." }));
      log.ok(`KV status:${slug} = error`);
    } else if (cmd === "report") {
      const path = await findReportJson();
      if (!path) { log.err(`no report.json under pipeline/out/ to publish for "${slug}"`); process.exitCode = 1; return; }
      const content = await readFile(path, "utf8");
      let rep = null, generated_at = null;
      try { rep = JSON.parse(content); generated_at = rep?.meta?.generated_at || null; } catch { /* keep null */ }
      await kvPut(`report:${slug}`, content);
      await kvPut(`status:${slug}`, JSON.stringify({ state: "done", stage: "done", updated_at: new Date().toISOString(), generated_at, message: "Report ready." }));
      if (rep) { try { await writeLibraryCard(slug, rep); log.ok(`KV report-meta:${slug} written (library)`); } catch (e) { log.warn(`library card write failed (non-fatal): ${e.message}`); } }
      log.ok(`KV report:${slug} published (${content.length} bytes) → status done`);
    } else {
      log.err(`unknown command "${cmd}"`); process.exitCode = 1;
    }
  } catch (e) {
    if (bestEffort) { log.warn(`KV ${cmd} failed (non-fatal): ${e.message}`); return; }
    log.err(`KV ${cmd} failed: ${e.message}`); process.exitCode = 1;
  }
}

main();
