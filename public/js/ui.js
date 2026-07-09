// ui.js — small, dependency-free DOM/format helpers shared across the app.

/** querySelector shorthand. */
export const qs = (sel, root = document) => root.querySelector(sel);
/** querySelectorAll → real array. */
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Resolve after `ms` — used by the report poll loop. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Clamp `n` into [lo, hi]. */
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Debounce `fn` by `ms` (leading-edge off). */
export function debounce(fn, ms = 120) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Escape a string for safe insertion into innerHTML. */
export function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap the first case-insensitive match of `query` in <mark>; input is escaped first. */
export function highlightMatch(text, query) {
  const safe = escapeHtml(text);
  const q = (query || "").trim();
  if (!q) return safe;
  const idx = safe.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return safe;
  const end = idx + q.length;
  return (
    safe.slice(0, idx) +
    '<mark class="bg-transparent text-indigo-600 font-semibold">' +
    safe.slice(idx, end) +
    "</mark>" +
    safe.slice(end)
  );
}

/** (Re)render Lucide icons if the CDN script loaded. */
export function renderIcons() {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

/** Toggle an element's `hidden`-ish visibility using Tailwind's `hidden` class. */
export function show(el, visible = true) {
  if (!el) return;
  el.classList.toggle("hidden", !visible);
}
