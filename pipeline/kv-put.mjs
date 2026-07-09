#!/usr/bin/env node
// kv-put.mjs — STEP 10: publish pipeline results to Cloudflare KV so the Worker can serve them.
// Called by fetch-company.yml at three points:
//   node pipeline/kv-put.mjs status <slug> running "Analyzing <company>…"   (before the run)
//   node pipeline/kv-put.mjs report <slug>                                  (on success)
//   node pipeline/kv-put.mjs status <slug> error "message"                  (on failure)
//
// Keys: status:<slug> = { state, updated_at, message }; report:<slug> = the finished report JSON.
// The `report` command finds the single pipeline/out/*/report.json (the run's output) and, after
// PUT-ing it, also flips status:<slug> to "done". Missing CF creds → a clear WARN + exit 0, so a
// run without KV configured still completes (and uploads its artifact) rather than failing.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { kvPut, kvConfigured } from "./lib/kv.mjs";
import { log } from "./lib/util.mjs";

const OUT_ROOT = fileURLToPath(new URL("./out/", import.meta.url));

/** Locate the single report.json this run produced (the pipeline's dir slug may differ from <slug>). */
async function findReportJson() {
  let entries = [];
  try { entries = await readdir(OUT_ROOT, { withFileTypes: true }); } catch { return null; }
  const hits = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(OUT_ROOT, e.name, "report.json");
    try { await readFile(p, "utf8"); hits.push(p); } catch { /* no report here */ }
  }
  return hits[0] || null; // one company per run → one report.json
}

async function main() {
  const [cmd, slug, arg3, arg4] = process.argv.slice(2);
  if (!cmd || !slug) { log.err("usage: kv-put.mjs <status|report> <slug> [state] [message]"); process.exitCode = 1; return; }

  if (!kvConfigured()) {
    log.warn(`CF KV not configured (CF_ACCOUNT_ID / CF_KV_NAMESPACE_ID / CF_API_TOKEN) — skipping KV ${cmd} for "${slug}"`);
    return; // exit 0 — don't fail the pipeline just because KV isn't wired
  }

  try {
    if (cmd === "status") {
      const state = arg3 || "running";
      const payload = { state, updated_at: new Date().toISOString(), message: arg4 || "" };
      await kvPut(`status:${slug}`, JSON.stringify(payload));
      log.ok(`KV status:${slug} = ${state}`);
    } else if (cmd === "report") {
      const path = await findReportJson();
      if (!path) { log.err(`no report.json under pipeline/out/ to publish for "${slug}"`); process.exitCode = 1; return; }
      const content = await readFile(path, "utf8");
      await kvPut(`report:${slug}`, content);
      await kvPut(`status:${slug}`, JSON.stringify({ state: "done", updated_at: new Date().toISOString(), message: "Report ready." }));
      log.ok(`KV report:${slug} published (${content.length} bytes) → status done`);
    } else {
      log.err(`unknown command "${cmd}"`); process.exitCode = 1;
    }
  } catch (e) {
    log.err(`KV ${cmd} failed: ${e.message}`);
    process.exitCode = 1;
  }
}

main();
