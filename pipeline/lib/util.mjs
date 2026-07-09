// util.mjs — parsing + provenance helpers for the fetch pipeline. No deps.

/** Parse a Screener-style number: "₹ 20,832 Cr.", "4,200", "23.4%", "1.2", "(123)" → Number|null. */
export function parseNum(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") return isFinite(raw) ? raw : null;
  const str = String(raw);
  if (/^\s*[-–—]?\s*$/.test(str) || /^\s*n\.?\s*a\.?\s*$/i.test(str)) return null; // blank / "-" / "NA"
  const neg = /^\s*\(.*\)\s*$/.test(str); // accountancy negatives
  const cleaned = str.replace(/[,\s₹%]/g, ""); // drop separators, currency, percent
  const m = cleaned.match(/-?\d+(?:\.\d+)?/); // first number; ignores trailing "Cr", "Cr.", letters
  if (!m) return null;
  let n = Number(m[0]);
  if (!isFinite(n)) return null;
  if (neg && n > 0) n = -n;
  return n;
}

/** Round to n decimals, returning a finite Number or null. */
export function round(v, n = 1) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  const p = 10 ** n;
  return Math.round(v * p) / p;
}

/** A URL-safe slug from a company name/ticker. */
export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "company";
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Parse a loose date string ("May 2026", "6 May 2026", "2026-05-06") → { y, m, iso }|null. */
export function parseLooseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { y: +m[1], m: +m[2], iso: `${m[1]}-${m[2]}-${m[3]}` };
  m = s.match(/(\d{1,2})?\s*([A-Za-z]{3,})[a-z]*\.?\s*(\d{4})/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) {
      const day = m[1] ? String(+m[1]).padStart(2, "0") : "01";
      return { y: +m[3], m: mon, iso: `${m[3]}-${String(mon).padStart(2, "0")}-${day}` };
    }
  }
  return null;
}

/**
 * Infer the reported quarter (e.g. "Q4FY26") from a concall date. Indian results land ~1–2
 * months after quarter-end: Apr/May→Q4, Jul/Aug→Q1, Oct/Nov→Q2, Jan/Feb→Q3.
 * Returns { quarter, confident } (confident=false for ambiguous months).
 */
export function quarterFromDate(d) {
  if (!d || !d.y || !d.m) return { quarter: null, confident: false };
  const { y, m } = d;
  let q, fy;
  if (m === 4 || m === 5 || m === 6) { q = 4; fy = y; }        // Jan–Mar results
  else if (m === 7 || m === 8 || m === 9) { q = 1; fy = y + 1; } // Apr–Jun results
  else if (m === 10 || m === 11 || m === 12) { q = 2; fy = y + 1; } // Jul–Sep results
  else { q = 3; fy = y; }                                       // Oct–Dec results (Jan–Mar report)
  const confident = ![3, 6, 9, 12].includes(m); // boundary months are ambiguous
  return { quarter: `Q${q}FY${String(fy % 100).padStart(2, "0")}`, confident };
}

/**
 * The most recent quarter that SHOULD be reported by `runIso` (results land ~50+ days after
 * quarter-end). Used to flag when the latest posted concall is older than expected.
 */
export function expectedQuarter(runIso) {
  const [Y, M, D] = String(runIso).slice(0, 10).split("-").map(Number);
  if (!Y) return null;
  const runDays = Date.UTC(Y, M - 1, D) / 86400000;
  const cand = [];
  for (let y = Y - 1; y <= Y; y++) {
    for (const [em, q] of [[3, 4], [6, 1], [9, 2], [12, 3]]) {
      const endDays = Date.UTC(y, em, 0) / 86400000; // last day of calendar month `em`
      if (runDays - endDays >= 50) cand.push({ y, q, endDays });
    }
  }
  if (!cand.length) return null;
  cand.sort((a, b) => b.endDays - a.endDays);
  const { y, q } = cand[0];
  const fy = q === 4 ? y : y + 1; // Q4 ends in the FY's own March; Q1–Q3 end in the next FY
  return `Q${q}FY${String(fy % 100).padStart(2, "0")}`;
}

/** Pull an explicit "Q4 FY26" / "Q4FY2026" from a title, if present. → "Q4FY26"|null. */
export function quarterFromTitle(title) {
  if (!title) return null;
  const m = String(title).match(/Q([1-4])\s*'?\s*FY\s*'?(\d{2,4})/i);
  if (!m) return null;
  const yy = m[2].length === 4 ? m[2].slice(2) : m[2].padStart(2, "0");
  return `Q${m[1]}FY${yy}`;
}

/** Wrap a value with its provenance so every number in the bundle says where it came from. */
export function sourced(value, source, note) {
  const o = { value: value ?? null, source: source ?? null };
  if (note) o.note = note;
  return o;
}

// Tiny console logger with sections, so the CI log reads as an evidence trail.
export const log = {
  step: (m) => console.log(`\n▸ ${m}`),
  ok: (m) => console.log(`  ✓ ${m}`),
  warn: (m) => console.log(`  ⚠ ${m}`),
  info: (m) => console.log(`  · ${m}`),
  err: (m) => console.log(`  ✗ ${m}`),
};
