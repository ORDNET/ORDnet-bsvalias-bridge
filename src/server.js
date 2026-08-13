// ORDnet bsvalias bridge — spec: A-BSVALIAS-BRIDGE-SPEC.md
// Zero-dependency Node >= 20. Routes:
//   GET  /.well-known/bsvalias
//   GET  /bsvalias/id/{paymail}                          (pki)
//   POST /bsvalias/address/{paymail}                     (basic resolution)
//   GET  /bsvalias/verify-pubkey/{paymail}/{pubkey}
//   GET  /bsvalias/public-profile/{paymail}
//   POST /bsvalias/p2p-payment-destination/{paymail}
//   POST /bsvalias/receive-transaction/{paymail}
//   GET  /bridge/health
import { createServer } from "node:http";
import { config } from "./config.js";
import { mapHandle, httpErr, resolveName, pubkeyForName, broadcastTx, rateLimit } from "./services.js";

/**
 * Percent-decode without ever throwing.
 *
 * decodeURIComponent raises URIError on malformed input ("%ZZ", a lone "%", a
 * truncated escape), and an uncaught throw in a Node request handler is fatal
 * to the process. The Merkle-Resolver hit exactly this (its K3) and fixed it;
 * this file kept the raw call and answered 500 on `GET /bsvalias/id/%ZZ`.
 * Fixing it in one repository and not the other is the drift that copy-paste
 * causes — hence the shared-core work on the roadmap.
 *
 * Returns null for undecodable input; callers treat that as a malformed
 * request, which is what it is.
 */
const MAX_HANDLE_LEN = 2100; // SNS-NAME-1 caps a name at 2048 bytes
function safeDecode(segment) {
  if (typeof segment !== "string" || segment.length === 0) return "";
  if (segment.length > MAX_HANDLE_LEN) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
import { ReferenceStore } from "./store.js";
import { parseTx, txPaysOutputs } from "./tx.js";

const refs = new ReferenceStore({ ttlMs: config.referenceTtlMs, file: config.referenceFile });

// ---------- helpers ----------
function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    ...extraHeaders,
  });
  res.end(payload);
}

function fail(res, e) {
  const status = e.status || 500;
  const code = e.code || "internal_error";
  json(res, status, { code, message: status === 500 ? "internal error" : e.message });
}

async function readJsonBody(req, maxBytes = 2_000_000) {
  return await new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) { reject(httpErr(413, "too_large", "body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(httpErr(400, "malformed_json", "body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}

/** Parse `{alias}@{domain.tld}` from a path segment (URL-decoded). */
function parsePaymail(segment) {
  const handle = safeDecode(segment);
  if (handle === null) throw httpErr(400, "malformed_handle", "handle is not valid percent-encoded text");
  const at = handle.lastIndexOf("@");
  if (at <= 0 || at === handle.length - 1) throw httpErr(400, "malformed_handle", "expected alias@domain.tld");
  return { handle, alias: handle.slice(0, at), domain: handle.slice(at + 1) };
}

function clientIp(req) {
  // Behind your own reverse proxy, trust X-Forwarded-For's first hop.
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

// ---------- capability document (spec §3) ----------
const base = config.publicBaseUrl.replace(/\/+$/, "");
const CAPABILITY_DOC = {
  bsvalias: "1.0",
  capabilities: {
    "6745385c3fc0": false, // sender validation NOT required (spec §7)
    pki: `${base}/bsvalias/id/{alias}@{domain.tld}`,
    paymentDestination: `${base}/bsvalias/address/{alias}@{domain.tld}`,
    a9f510c16bde: `${base}/bsvalias/verify-pubkey/{alias}@{domain.tld}/{pubkey}`,
    f12f968c92d6: `${base}/bsvalias/public-profile/{alias}@{domain.tld}`,
    "2a40af698840": `${base}/bsvalias/p2p-payment-destination/{alias}@{domain.tld}`,
    "5f1323cddf31": `${base}/bsvalias/receive-transaction/{alias}@{domain.tld}`,
  },
};

// ---------- route handlers ----------
async function handlePki(res, paymail) {
  const { name, domainName } = await mapHandle(paymail.alias, paymail.domain);
  await resolveName(name); // 404s unregistered names before pki lookup
  const pubkey = await pubkeyForName(domainName); // identity key lives on the name
  json(res, 200, { bsvalias: "1.0", handle: paymail.handle, pubkey },
    { "cache-control": "public, max-age=300" });
}

async function handleAddress(req, res, paymail) {
  const body = await readJsonBody(req);
  // 6745385c3fc0=false: never reject for a missing signature. Loose dt check only.
  if (body.dt) {
    const dt = Date.parse(body.dt);
    if (!Number.isNaN(dt) && Math.abs(Date.now() - dt) > 10 * 60_000) {
      throw httpErr(400, "stale_request", "dt too far from server time");
    }
  }
  const { name } = await mapHandle(paymail.alias, paymail.domain);
  const { holderScript } = await resolveName(name);
  console.info(`[address] handle=${paymail.handle} sender=${body.senderHandle || "-"}`);
  json(res, 200, { output: holderScript });
}

async function handleVerifyPubkey(res, paymail, pubkeyParam) {
  const { name, domainName } = await mapHandle(paymail.alias, paymail.domain);
  await resolveName(name);
  const decodedPubkey = safeDecode(pubkeyParam);
  if (decodedPubkey === null) throw httpErr(400, "invalid_pubkey", "pubkey is not valid percent-encoded text");
  const candidate = decodedPubkey.toLowerCase();
  let match = false;
  try { match = (await pubkeyForName(domainName)) === candidate; }
  catch (e) { if (e.code !== "no_pki") throw e; } // no published key => match:false
  json(res, 200, { bsvalias: "1.0", handle: paymail.handle, pubkey: candidate, match });
}

async function handlePublicProfile(res, paymail) {
  const { name, domainName } = await mapHandle(paymail.alias, paymail.domain);
  await resolveName(name);
  json(res, 200, {
    name: `${name} (ORDnet)`,
    avatar: `${config.avatarBaseUrl}/${encodeURIComponent(domainName)}`,
  }, { "cache-control": "public, max-age=300" });
}

async function handleP2pDestination(req, res, paymail) {
  const body = await readJsonBody(req);
  const satoshis = body.satoshis;
  if (!Number.isInteger(satoshis) || satoshis <= 0 || satoshis > 2.1e15) {
    throw httpErr(400, "invalid_satoshis", "satoshis must be a positive integer");
  }
  const { name } = await mapHandle(paymail.alias, paymail.domain);
  const { holderScript } = await resolveName(name);
  const outputs = [{ script: holderScript, satoshis }];
  const reference = refs.issue(paymail.handle, outputs);
  console.info(`[p2p-dest] handle=${paymail.handle} sats=${satoshis} ref=${reference}`);
  json(res, 200, { outputs, reference });
}

async function handleReceiveTx(req, res, paymail) {
  const body = await readJsonBody(req, 10_000_000); // txs can be larger
  const { hex, reference } = body;
  if (typeof reference !== "string" || !reference.startsWith("ordnet-")) {
    throw httpErr(400, "invalid_reference", "missing or malformed reference");
  }

  // 1. reference must exist, be unexpired, and belong to this handle
  const entry = refs.peek(reference, paymail.handle);
  if (!entry) throw httpErr(404, "unknown_reference", "reference not found, expired, or wrong handle");

  // 2. tx must contain the exact issued output(s)
  let parsed;
  try { parsed = parseTx(hex); }
  catch { throw httpErr(400, "invalid_transaction", "could not parse transaction hex"); }
  if (!txPaysOutputs(parsed, entry.outputs)) {
    throw httpErr(400, "output_mismatch", "transaction does not pay the issued destination");
  }

  // Single-use: a consumed reference only re-accepts the *same* tx (idempotent retry).
  if (entry.consumed && entry.txid && entry.txid !== parsed.txid) {
    throw httpErr(409, "reference_consumed", "reference already used");
  }

  // 3. broadcast via ORDnet's own node (idempotent)
  const txid = await broadcastTx(hex, parsed.txid);

  // 4. mark consumed
  entry.txid = parsed.txid;
  refs.consume(reference);

  // 5. opportunistic metadata logging (never hard-require signature in V1)
  const sender = body?.metadata?.sender || "-";
  console.info(`[receive-tx] handle=${paymail.handle} sender=${sender} ref=${reference} txid=${txid}`);
  json(res, 200, { txid, note: "received" });
}

// ---------- router ----------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "OPTIONS") return json(res, 204, {});

    if (req.method === "GET" && url.pathname === "/.well-known/bsvalias") {
      return json(res, 200, CAPABILITY_DOC, { "cache-control": "public, max-age=86400" });
    }
    if (req.method === "GET" && url.pathname === "/bridge/health") {
      return json(res, 200, { ok: true });
    }

    if (parts[0] !== "bsvalias" || parts.length < 3) throw httpErr(404, "not_found", "unknown route");
    const route = parts[1];
    const paymail = parsePaymail(parts[2]);
    const ip = clientIp(req);

    const strict = route === "receive-transaction";
    const limit = strict ? config.rateLimitReceiveTx : config.rateLimitGeneral;
    if (!rateLimit(ip, strict ? "rx" : "gen", limit)) {
      throw httpErr(429, "rate_limited", "too many requests");
    }

    if (req.method === "GET" && route === "id") return await handlePki(res, paymail);
    if (req.method === "POST" && route === "address") return await handleAddress(req, res, paymail);
    if (req.method === "GET" && route === "verify-pubkey") return await handleVerifyPubkey(res, paymail, parts[3]);
    if (req.method === "GET" && route === "public-profile") return await handlePublicProfile(res, paymail);
    if (req.method === "POST" && route === "p2p-payment-destination") return await handleP2pDestination(req, res, paymail);
    if (req.method === "POST" && route === "receive-transaction") return await handleReceiveTx(req, res, paymail);

    throw httpErr(404, "not_found", "unknown route");
  } catch (e) {
    if (!e.status) console.error("[bridge] internal error:", e);
    fail(res, e);
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(config.port, config.host, () => {
    console.info(`ORDnet bsvalias bridge listening on ${config.host}:${config.port}`);
    console.info(`capability doc: ${config.publicBaseUrl}/.well-known/bsvalias`);
  });
}

export { server };
