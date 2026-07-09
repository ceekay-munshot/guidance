// out.mjs — locate a company's pipeline/out/<slug>/ directory by query/slug/ticker/company
// (else most-recent), shared by the Step 8 scripts. Mirrors extract-concall.mjs's findBundleDir.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Find the out dir whose bundle.json matches `arg`, else the most recently fetched. → {dir,slug,bundle}|null */
export async function findOutDir(outRoot, arg) {
  let entries = [];
  try { entries = await readdir(outRoot, { withFileTypes: true }); } catch { return null; }
  const cands = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const bundle = JSON.parse(await readFile(join(outRoot, e.name, "bundle.json"), "utf8"));
      cands.push({ dir: join(outRoot, e.name), slug: e.name, bundle });
    } catch { /* no/invalid bundle.json here */ }
  }
  if (!cands.length) return null;
  if (arg) {
    const q = arg.trim().toLowerCase();
    const hit = cands.find((c) =>
      [c.bundle.query, c.slug, c.bundle.meta?.ticker, c.bundle.meta?.company].some((v) => (v || "").toLowerCase() === q)
    );
    if (hit) return hit;
  }
  cands.sort((a, b) => String(b.bundle.fetched_at || "").localeCompare(String(a.bundle.fetched_at || "")));
  return cands[0];
}
