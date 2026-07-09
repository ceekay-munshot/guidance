// validate.mjs — a compact JSON-Schema (draft-07 subset) validator, enough for report.schema.json:
// type (incl. arrays + null), required, additionalProperties:false, properties, items, enum,
// pattern, and $ref (resolved against a root schema). Returns a list of "path: message" errors.

function typeOk(v, t) {
  if (Array.isArray(t)) return t.some((x) => typeOk(v, x));
  switch (t) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && isFinite(v);
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "object": return v && typeof v === "object" && !Array.isArray(v);
    case "array": return Array.isArray(v);
    case "null": return v === null;
    default: return true;
  }
}

function resolveRef(node, root) {
  if (node && node.$ref) {
    const parts = node.$ref.replace(/^#\//, "").split("/");
    let o = root;
    for (const k of parts) o = o?.[k];
    return o || {};
  }
  return node;
}

/**
 * Validate `value` against `schema` (a node of `root`). Returns string[] of errors (empty = valid).
 * `opts.allowAt(path, value)` → true to waive a type error at a specific path (documented exceptions).
 */
export function validate(schema, value, root = schema, opts = {}, path = "$") {
  const s = resolveRef(schema, root);
  const errs = [];
  if (s.type && !typeOk(value, s.type)) {
    if (!(opts.allowAt && opts.allowAt(path, value))) {
      errs.push(`${path}: expected ${JSON.stringify(s.type)}, got ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`);
    }
    return errs; // type wrong → don't dig deeper
  }
  if (s.enum && !s.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(s.enum)}`);
  if (s.pattern && typeof value === "string" && !new RegExp(s.pattern).test(value)) errs.push(`${path}: does not match /${s.pattern}/`);
  if (typeOk(value, "object") && (s.properties || s.required || s.additionalProperties === false)) {
    for (const k of s.required || []) if (!(k in value)) errs.push(`${path}: missing required "${k}"`);
    for (const k of Object.keys(value)) {
      if (s.properties && s.properties[k]) errs.push(...validate(s.properties[k], value[k], root, opts, `${path}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${path}: unexpected key "${k}"`);
    }
  }
  if (typeOk(value, "array") && s.items) value.forEach((el, i) => errs.push(...validate(s.items, el, root, opts, `${path}[${i}]`)));
  return errs;
}
