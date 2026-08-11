// Handle mapping (spec §4), resolver client, broadcaster, rate limiter.
import { config } from "./config.js";

// ---------- Handle mapping (D1 + D2) ----------
const HANDLE_RE = /^[a-zA-Z0-9.\-+_]+$/;

// ---------- v1.1 multi-tenant: live TLD set (resolver /health is the source) ----------
const tldState = {
  set: new Set(config.snsTldsFallback),
  at: 0,           // last successful refresh
  inflight: null,  // dedupe concurrent refreshes
};

async function refreshTlds() {
  if (tldState.inflight) return tldState.inflight;
  tldState.inflight = (async () => {
    try {
      const res = await fetch(`${config.resolverBaseUrl}/health`, {
        redirect: "error", signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return;
      const j = await res.json();
      const live = [...(j.tlds || []), ...(j.retired_tlds || [])]
        .map((t) => String(t).toLowerCase());
      if (live.length) { tldState.set = new Set(live); tldState.at = Date.now(); }
    } catch { /* keep previous set; fallback never goes away */ }
    finally { tldState.inflight = null; }
  })();
  return tldState.inflight;
}

/** True when `domain` is a web3 name this ecosystem serves (name.tld, known TLD). */
export async function isWeb3Domain(domain) {
  const d = String(domain || "").toLowerCase();
  const dot = d.indexOf(".");
  if (dot <= 0 || dot !== d.lastIndexOf(".") || dot === d.length - 1) return false;
  if (Date.now() - tldState.at > config.tldRefreshMs) await refreshTlds();
  return tldState.set.has(d.slice(dot + 1));
}

/**
 * Map a Paymail handle to a resolver input. ONE form, deliberately:
 *
 * NATIVE web3 handle: `<mailbox>@<name>.<tld>` where <tld> is a recognised
 * web3 TLD — `info@earthlog.web3`. The whole handle IS the resolver's own
 * mailbox address form; it passes through unchanged and the resolver
 * applies its mailbox + fallback semantics.
 *
 * There is NO house-domain aliasing (no `name@ordnet.io` form): a web3 name
 * is addressed as itself, never as an alias under someone else's domain.
 *
 * Returns { name, domainName } — `name` is the resolver input, `domainName`
 * the underlying SNS name (identity anchor for pki/profile) — or throws.
 */
export async function mapHandle(alias, domain) {
  const dom = String(domain || "").toLowerCase();
  if (!alias || alias.length > 200 || !HANDLE_RE.test(alias)) {
    throw httpErr(400, "malformed_alias", "alias contains invalid characters");
  }
  if (await isWeb3Domain(dom)) {
    if (alias.includes("@")) throw httpErr(400, "malformed_alias", "alias contains @");
    return { name: `${alias.toLowerCase()}@${dom}`, domainName: dom };
  }
  throw httpErr(404, "unknown_domain", "this bridge serves native web3 domains (mailbox@name.tld) only");
}

export function httpErr(status, code, message) {
  const e = new Error(message);
  e.status = status; e.code = code;
  return e;
}

// ---------- Resolver client (with 300 s cache mirror) ----------
const cache = new Map(); // key -> { at, value } ; value === null means negative-cached 404

async function cachedGet(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < config.resolverCacheMs) {
    if (hit.value === null) throw httpErr(404, "not_registered", "name not registered");
    return hit.value;
  }
  const res = await fetch(`${config.resolverBaseUrl}${path}`, {
    redirect: "error", // never follow redirects on internal fetches (spec §7)
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) {
    cache.set(path, { at: Date.now(), value: null });
    throw httpErr(404, "not_registered", "name not registered");
  }
  if (!res.ok) throw httpErr(502, "resolver_error", `resolver returned ${res.status}`);
  const value = await res.json();
  cache.set(path, { at: Date.now(), value });
  return value;
}

/** Resolve a name -> { holderScript, holderAddress } (fail-closed). */
export async function resolveName(name) {
  const data = await cachedGet(`/resolve/${encodeURIComponent(name)}`);
  const holderScript = data.holder_script || data.holderScript;
  const holderAddress = data.holder_address || data.holderAddress;
  // Keep resolver refusal semantics: anything without a usable holder is a 404 here.
  if (!holderScript || data.not_verified === true || data.no_holder === true) {
    throw httpErr(404, "not_registered", "name has no verified holder");
  }
  if (!/^[0-9a-fA-F]+$/.test(holderScript) || holderScript.length % 2 !== 0) {
    throw httpErr(502, "resolver_error", "resolver returned malformed script");
  }
  return { holderScript: holderScript.toLowerCase(), holderAddress };
}

/** Fetch the holder-published identity pubkey (D3, via resolver /pubkey). */
export async function pubkeyForName(name) {
  const data = await cachedGet(`/pubkey/${encodeURIComponent(name)}`);
  const pubkey = data.pubkey || data.public_key;
  if (!pubkey || !/^0[23][0-9a-fA-F]{64}$/.test(pubkey)) {
    throw httpErr(404, "no_pki", "no identity pubkey published for this name");
  }
  return pubkey.toLowerCase();
}

// ---------- Broadcaster ----------
/**
 * Broadcast through ORDnet's own node service; adjust the request shape here
 * if your node API differs. Must be idempotent-friendly: treat
 * "already known / already in mempool or block" answers as success.
 */
export async function broadcastTx(hex, expectedTxid) {
  // v1.0.1 — broadcasts via WhatsOnChain (POST tx/raw, {"txhex": ...}), the
  // same channel the ORDmail app uses; there is no internal node endpoint on
  // the registry server. WoC answers with the txid as a quoted text string on
  // success, and with a plain-text error otherwise.
  // Format-agnostisch: `txhex` is wat WhatsOnChain leest, `rawtx` is wat de
  // eigen ordnet-api (POST /v1/{chain}/tx/broadcast) voorschrijft. Beide
  // meesturen betekent dat de overstap naar de eigen node — zodra dat
  // endpoint live is — alleen BRIDGE_BROADCAST_URL is, geen code.
  const res = await fetch(config.broadcastUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txhex: hex, rawtx: hex }),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const raw = (await res.text().catch(() => "")).trim();
  let text = raw.replace(/"/g, "");
  try { const j = JSON.parse(raw); if (j && typeof j.txid === "string") text = j.txid; } catch {}
  if (res.ok && /^[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase();
  const msg = raw.toLowerCase();
  // H1 — this used to be a substring match on "known", and "unknown" contains
  // "known". Any upstream failure with the word "unknown" in it — a Cloudflare
  // error page, "unknown host", a 500 body — was read as a SUCCESSFUL
  // broadcast. The recipient saw "received", the transaction did not exist,
  // and the payment reference was consumed. Reproduced by the reviewer with a
  // 500 "unknown host" response.
  //
  // Two changes: match whole phrases rather than substrings, and only treat a
  // duplicate as success when the upstream actually answered (an HTTP error is
  // never an idempotent success).
  const ALREADY_KNOWN = [
    "already in the mempool",
    "already in mempool",
    "already known",
    "txn-already-known",
    "txn-already-in-mempool",
    "transaction already in block chain",
    "already have transaction",
    "duplicate transaction",
  ];
  // Note: a duplicate legitimately arrives with a non-2xx status (WhatsOnChain
  // answers 409), so the status is deliberately NOT part of this test. The
  // phrase list is what does the work.
  if (expectedTxid && ALREADY_KNOWN.some((phrase) => msg.includes(phrase))) {
    return expectedTxid; // idempotent: it is on the network, that is success
  }
  throw httpErr(502, "broadcast_failed", "could not broadcast transaction");
}

// ---------- Rate limiter (sliding minute window per IP) ----------
const buckets = new Map(); // key -> number[] of timestamps

export function rateLimit(ip, key, limit) {
  const now = Date.now();
  const k = `${ip}:${key}`;
  const arr = (buckets.get(k) || []).filter((t) => now - t < 60_000);
  if (arr.length >= limit) { buckets.set(k, arr); return false; }
  arr.push(now);
  buckets.set(k, arr);
  if (buckets.size > 50_000) buckets.clear(); // crude memory guard
  return true;
}
