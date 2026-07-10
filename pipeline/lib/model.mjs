// model.mjs — PURE financial-model math for Step 9. These formulas MIRROR the frontend's
// computeModel/seedEdits (public/js/report.js) EXACTLY, so the seeded report.json reconciles with
// the live dashboard on load (no recompute drift). The Step-9 test additionally imports the real
// frontend computeModel and asserts equality — belt and suspenders.

const numOr = (v, fb = null) => (typeof v === "number" && isFinite(v) ? v : fb);
export const round1 = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v * 10) / 10 : null);
export const round2 = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * Forecast the core lines from FY26A + the (already-rounded) assumption levers, using the frontend's
 * formulas: revenue compounds by growth; EBITDA/PAT = revenue × margin%. Store margins/growth at the
 * SAME rounding used here so seedEdits→computeModel reproduces these numbers.
 */
export function computeForecast(fy26a, a) {
  const rev26 = numOr(fy26a.revenue, 0);
  const g27 = numOr(a.growth_fy27, 0), g28 = numOr(a.growth_fy28, 0);
  const em27 = numOr(a.ebitda_margin_fy27, 0), em28 = numOr(a.ebitda_margin_fy28, 0);
  const nm27 = numOr(a.net_margin_fy27, 0), nm28 = numOr(a.net_margin_fy28, 0);
  const rev27 = rev26 * (1 + g27 / 100);
  const rev28 = rev27 * (1 + g28 / 100);
  return {
    revenue: { fy26a: rev26, fy27e: rev27, fy28e: rev28 },
    ebitda: { fy26a: numOr(fy26a.ebitda), fy27e: (rev27 * em27) / 100, fy28e: (rev28 * em28) / 100 },
    ebitda_margin_pct: { fy26a: numOr(fy26a.ebitda_margin_pct), fy27e: em27, fy28e: em28 },
    pat: { fy26a: numOr(fy26a.pat), fy27e: (rev27 * nm27) / 100, fy28e: (rev28 * nm28) / 100 },
    net_margin_pct: { fy26a: numOr(fy26a.net_margin_pct), fy27e: nm27, fy28e: nm28 },
    gross_margin_pct: { fy26a: numOr(fy26a.gross_margin_pct), fy27e: numOr(a.gross_margin_fy27), fy28e: numOr(a.gross_margin_fy28) },
  };
}

/**
 * Valuation multiples with the frontend's EXACT definitions: market_cap = cmp × shares_out_cr;
 * ev = market_cap + net_debt_cr; P/E = mc/PAT; EV/EBITDA = ev/EBITDA; P/S = mc/Revenue. A multiple
 * whose denominator ≤ 0 is "n.m." → null (schema-valid: valuation multiples are number|null, so a
 * genuine n.m. — loss-making / negative EBITDA — validates and renders as "n.m."). Rounded to 1 dp
 * to match the sample. Returns the
 * three schema multiples plus market_cap/ev for the sanity-check text (not stored in report.valuation).
 */
export function computeValuation(inputs, f) {
  const cmp = Math.max(0, numOr(inputs.cmp, 0));
  const shares = numOr(inputs.shares_out_cr, 0), netDebt = numOr(inputs.net_debt_cr, 0);
  const marketCap = cmp * shares, ev = marketCap + netDebt;
  const ratio = (n, d) => (typeof d === "number" && d > 0 ? n / d : null); // ≤0 denom → n.m.
  const yr = (fn) => ({ fy27e: round1(fn("fy27e")), fy28e: round1(fn("fy28e")) });
  return {
    market_cap_cr: marketCap, ev_cr: ev,
    pe: yr((y) => ratio(marketCap, f.pat[y])),
    ev_ebitda: yr((y) => ratio(ev, f.ebitda[y])),
    price_sales: yr((y) => ratio(marketCap, f.revenue[y])),
  };
}

/** Was this metric guided by management on the call? Mirrors the frontend's leverBasis() basis pill. */
export function guidedFor(report, keywords) {
  const g = report.concall?.guidance ?? [];
  return g.some((x) => (x.source === "Transcript" || x.source === "PPT") && keywords.some((k) => String(x.metric || "").toLowerCase().includes(k)));
}

/** Monitorables = the specific GUIDED items from C.1, to verify delivered-vs-guided next quarter. */
export function deriveMonitorables(report) {
  const g = report.concall?.guidance ?? [];
  const items = g.map((x) => `${x.metric}${x.value ? ` (guided ${x.value})` : ""}: verify delivered vs guided next quarter`);
  // Fall back to a couple of expansion flags if the call gave no explicit guidance.
  if (!items.length) return (report.concall?.expansion_flags ?? []).map((f) => `${f.metric}: track the trajectory (${f.driver})`);
  return items;
}

/**
 * Is the forward multiple RICH versus history / peers? A >10% premium to a median counts as rich.
 * Returns the numbers + booleans so the sanity-check text can cite the actual figures.
 */
export function assessValuationRichness(fwdPe, ctx = {}) {
  const pe = numOr(fwdPe), hist = numOr(ctx.hist_median_pe), peer = numOr(ctx.peer_median_pe);
  const richVs = (m) => pe !== null && m !== null && m > 0 && pe > m * 1.10;
  return {
    fwd_pe: pe, hist_median_pe: hist, peer_median_pe: peer,
    prem_vs_hist: pe !== null && hist ? round1((pe / hist - 1) * 100) : null,
    prem_vs_peer: pe !== null && peer ? round1((pe / peer - 1) * 100) : null,
    is_rich_vs_hist: richVs(hist), is_rich_vs_peer: richVs(peer),
    is_rich: richVs(hist) || richVs(peer),
  };
}

/**
 * Deterministic F sanity-check prose. Always cites the actual computed multiples, and when the read
 * is positive BUT the forward multiple is rich vs history/peer, flags the disconnect explicitly with
 * the real median numbers. When benchmarks are missing, says so rather than inventing them.
 */
export function buildSanityCheck({ valuation, inputs, currentPe, richness, positiveTone }) {
  const money = (v) => `₹${Math.round(numOr(v, 0)).toLocaleString("en-IN")}cr`;
  const x = (v) => (v == null ? "n.m." : `${v}x`);
  const out = [];
  out.push(
    `At ₹${inputs.cmp} (mkt cap ${money(valuation.market_cap_cr)}, EV ${money(valuation.ev_cr)} incl. ${money(inputs.net_debt_cr)} net debt) the stock trades at ${x(valuation.pe.fy27e)} FY27E and ${x(valuation.pe.fy28e)} FY28E P/E, ${x(valuation.ev_ebitda.fy27e)} FY27E EV/EBITDA and ${x(valuation.price_sales.fy27e)} FY27E P/S.`
  );
  const bench = [];
  if (richness.hist_median_pe != null) bench.push(`its ~${richness.hist_median_pe}x 5-yr median P/E`);
  if (richness.peer_median_pe != null) bench.push(`a ~${richness.peer_median_pe}x peer median`);
  if (bench.length) {
    if (richness.is_rich && positiveTone) {
      out.push(`Note the disconnect: the read is constructive, yet FY27E P/E ${x(valuation.pe.fy27e)} is already RICH versus ${bench.join(" and ")} — the multiple already prices in the guided delivery, so any execution slip carries asymmetric downside.`);
    } else if (richness.is_rich) {
      out.push(`FY27E P/E ${x(valuation.pe.fy27e)} sits at a premium to ${bench.join(" and ")}; the multiple already embeds the guidance.`);
    } else {
      out.push(`FY27E P/E ${x(valuation.pe.fy27e)} is broadly in line with ${bench.join(" and ")} — not demanding relative to history/peers.`);
    }
  } else {
    out.push(`History/peer P/E benchmarks were not available from Screener, so richness is judged on the absolute forward multiple only.`);
  }
  if (currentPe != null) out.push(`(Current trailing P/E ≈ ${x(currentPe)}.)`);
  return out.join(" ");
}
