// kv.mjs — write to Cloudflare Workers KV via the REST API (used by the Action in Step 10 to
// publish status:<slug> and report:<slug>). Credentials come from env; nothing is logged.

const CF_BASE = "https://api.cloudflare.com/client/v4";

/** Are the three CF KV env vars present? */
export function kvConfigured(env = process.env) {
  return !!(env.CF_ACCOUNT_ID && env.CF_KV_NAMESPACE_ID && env.CF_API_TOKEN);
}

/**
 * PUT a single key's value (a string — store JSON as a JSON string). Throws on non-2xx.
 * The Bearer token is only ever sent in the Authorization header, never logged.
 */
export async function kvPut(key, value, env = process.env) {
  const url = `${CF_BASE}/accounts/${env.CF_ACCOUNT_ID}/storage/kv/namespaces/${env.CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "text/plain" },
      body: value,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`KV PUT ${key} → HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}
