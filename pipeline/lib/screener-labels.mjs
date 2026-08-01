// screener-labels.mjs — the row labels Screener uses in its P&L / balance sheet. Kept DEP-FREE (no
// cheerio) so the offline test suite, which runs BEFORE `npm install` in fetch-company.yml, can
// cover them.
//
// Screener renders TWO different skeletons and the difference is not cosmetic:
//
//   layout        operating line        margin line           debt line(s)
//   ─────────────────────────────────────────────────────────────────────────────────
//   standard      "Operating Profit"    "OPM %"               "Borrowings +"
//   lender        "Financing Profit"    "Financing Margin %"  "Deposits" (banks) + "Borrowing"
//
// Matching only the standard labels meant every bank/NBFC parsed with a null EBITDA and a null net
// debt — and because the self-check treated a missing EBITDA as fatal, no lender could EVER produce
// a report (Five-Star Business Finance failed this way five runs in a row). Note also the singular
// "Borrowing" on the lender balance sheet: the plural needle "borrowings" does not match it.
//
// Labels are matched as substrings of the NORMALISED row label (lower-cased, punctuation stripped),
// so "Borrowings +" → "borrowings" and "Borrowing" → "borrowing" both match the stem "borrowing".

/** P&L row needles, in the order they should be tried. */
export const PNL_LABELS = {
  revenue: ["sales", "revenue"],
  ebitda: ["operating profit", "financing profit"],
  ebitda_margin_pct: ["opm", "financing margin"],
  pat: ["net profit"],
};

/** Balance-sheet row needles. */
export const BS_LABELS = {
  // Stem, not plural: matches "Borrowings" (standard) AND "Borrowing" (lender).
  borrowings: ["borrowing"],
  cash: ["cash equivalents", "cash and bank", "cash & bank", "cash"],
  // Banks fund themselves with customer deposits. Those are operating funding, not borrowings, and
  // are deliberately NOT counted as debt — we only detect them to caveat the number.
  deposits: ["deposits"],
};

/** Does any normalised label in `labels` contain any of `needles`? Accepts an array, Set or Map keys. */
export function hasLabel(labels, needles) {
  for (const l of labels || []) if (needles.some((n) => String(l).includes(n))) return true;
  return false;
}

/** True when Screener rendered the LENDER P&L skeleton (bank / NBFC). */
export function isLenderLayout(pnlLabels) {
  return hasLabel(pnlLabels, ["financing profit", "financing margin"]);
}

/**
 * The caveat a lender's numbers must carry. For a bank or NBFC, borrowings are raw material rather
 * than leverage and interest is a cost of goods — so EV/EBITDA and net-debt-based multiples are not
 * meaningful, and Screener's "Financing Profit" (revenue − interest − opex) is what lands in the
 * EBITDA slot. Recorded in diagnostics so the report never presents these as like-for-like with a
 * manufacturer's.
 */
export const LENDER_NOTE =
  "lender layout (bank/NBFC): EBITDA is Screener's 'Financing Profit' (already net of interest cost) " +
  "and the margin is its 'Financing Margin %' — EV/EBITDA and net-debt multiples are not meaningful " +
  "for a lender; judge on P/E, P/B and RoA instead.";

export const DEPOSITS_NOTE =
  "bank balance sheet: customer deposits are excluded from net debt (operating funding, not borrowings)";
