// End-to-end tests: spins up a mock SNS resolver + mock node broadcaster,
// then the bridge, then exercises every route incl. the §8 negative cases.
// Run: node test/run-tests.js
import { createServer } from "node:http";
import { createHash } from "node:crypto";

// --- test config (must be set before importing the bridge) ---
process.env.NODE_ENV = "test";
process.env.BRIDGE_PUBLIC_BASE_URL = "https://sns.ordnet.io";
process.env.SNS_RESOLVER_URL = "http://127.0.0.1:18080";
process.env.BRIDGE_BROADCAST_URL = "http://127.0.0.1:18081/broadcast";
process.env.BRIDGE_REFERENCE_FILE = "/tmp/bridge-test-refs.json";
process.env.BRIDGE_RATE_RECEIVE = "1000"; // don't trip limits in tests
process.env.BRIDGE_RATE_GENERAL = "1000";

const { server } = await import("../src/server.js");
const { parseTx, txPaysOutputs } = await import("../src/tx.js");

// --- fixtures ---
const SCRIPT = "76a914" + "ab".repeat(20) + "88ac"; // fake P2PKH locking script
const PUBKEY = "02" + "cd".repeat(32);
const KNOWN = {
  "alexander.web3": { holder_script: SCRIPT, holder_address: "1FakeAddr" },
  "pay@alexander.web3": { holder_script: SCRIPT, holder_address: "1FakeAddr", mailbox: "pay", fallback: false },
  // v1.1 multi-tenant fixtures — the resolver's native mailbox form
  "earthlog.web3": { holder_script: SCRIPT, holder_address: "1FakeAddr" },
  "info@earthlog.web3": { holder_script: SCRIPT, holder_address: "1FakeAddr", mailbox: "info", fallback: false },
  "fable.claude": { holder_script: SCRIPT, holder_address: "1FakeAddr" },
  "hi@fable.claude": { holder_script: SCRIPT, holder_address: "1FakeAddr", mailbox: "hi", fallback: false },
};
const PUBKEYS = {
  "alexander.web3": { pubkey: PUBKEY },
  "earthlog.web3": { pubkey: PUBKEY },
  "fable.claude": { pubkey: PUBKEY },
};

// --- mock resolver ---
const resolver = createServer((req, res) => {
  const [, route, rawName] = req.url.split("/");
  if (route === "health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, tlds: ["web3", "claude"], retired_tlds: ["bsv"] }));
  }
  const name = decodeURIComponent(rawName || "");
  const table = route === "resolve" ? KNOWN : route === "pubkey" ? PUBKEYS : null;
  const hit = table && table[name];
  res.writeHead(hit ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify(hit || { code: "not_registered" }));
});

// --- mock node broadcaster ---
const seen = new Set();
const broadcaster = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  // WoC-vorm (v1.0.1): {"txhex"} in; txid als quoted tekst uit, fouten als
  // platte tekst — de mock spreekt exact wat de echte broadcaster spreekt.
  const { txhex } = JSON.parse(body);
  const txid = txidOf(txhex);
  const dup = seen.has(txid);
  seen.add(txid);
  res.writeHead(dup ? 409 : 200, { "content-type": "text/plain" });
  res.end(dup ? "txn-already-known" : JSON.stringify(txid));
});

// --- tiny tx builder (1 dummy input, given outputs) ---
function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b;
}
function buildTx(outputs, lockDiff = 0) {
  const chunks = [];
  chunks.push(Buffer.from([1, 0, 0, 0]));            // version
  chunks.push(varint(1));                             // 1 input
  chunks.push(Buffer.alloc(36, 7));                   // outpoint
  const unlock = Buffer.from("0011223344", "hex");
  chunks.push(varint(unlock.length), unlock);
  chunks.push(Buffer.from([0xff, 0xff, 0xff, 0xff])); // sequence
  chunks.push(varint(outputs.length));
  for (const o of outputs) {
    const v = Buffer.alloc(8); v.writeBigUInt64LE(BigInt(o.satoshis));
    const s = Buffer.from(o.script, "hex");
    chunks.push(v, varint(s.length), s);
  }
  const lt = Buffer.alloc(4); lt.writeUInt32LE(lockDiff); // vary locktime to vary txid
  chunks.push(lt);
  return Buffer.concat(chunks).toString("hex");
}
function txidOf(hex) {
  const raw = Buffer.from(hex, "hex");
  const a = createHash("sha256").update(raw).digest();
  const b = createHash("sha256").update(a).digest();
  return Buffer.from(b).reverse().toString("hex");
}

// --- assertion helpers ---
let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label} ${extra}`); }
}
const BASE = "http://127.0.0.1:18082";
async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// --- run ---
await new Promise((r) => resolver.listen(18080, "127.0.0.1", r));
await new Promise((r) => broadcaster.listen(18081, "127.0.0.1", r));
await new Promise((r) => server.listen(18082, "127.0.0.1", r));

console.log("\n[unit] tx parser");
{
  const hex = buildTx([{ satoshis: 1000, script: SCRIPT }, { satoshis: 42, script: "6a0101" }]);
  const parsed = parseTx(hex);
  check("parses two outputs", parsed.outputs.length === 2);
  check("output values/scripts match", parsed.outputs[0].satoshis === 1000 && parsed.outputs[0].script === SCRIPT);
  check("txid is 32-byte hex", /^[0-9a-f]{64}$/.test(parsed.txid));
  check("txPaysOutputs true on exact match", txPaysOutputs(parsed, [{ satoshis: 1000, script: SCRIPT }]));
  check("txPaysOutputs false on wrong sats", !txPaysOutputs(parsed, [{ satoshis: 999, script: SCRIPT }]));
  check("multiplicity counted", !txPaysOutputs(parsed, [{ satoshis: 1000, script: SCRIPT }, { satoshis: 1000, script: SCRIPT }]));
  let threw = false; try { parseTx(hex + "00"); } catch { threw = true; }
  check("trailing bytes rejected", threw);
  threw = false; try { parseTx("zz"); } catch { threw = true; }
  check("bad hex rejected", threw);
}

console.log("\n[e2e] capability document");
{
  const { status, body } = await call("GET", "/.well-known/bsvalias");
  check("200", status === 200);
  check("bsvalias 1.0", body.bsvalias === "1.0");
  const caps = body.capabilities || {};
  for (const k of ["pki", "paymentDestination", "a9f510c16bde", "f12f968c92d6", "2a40af698840", "5f1323cddf31"]) {
    check(`capability ${k} present`, typeof caps[k] === "string" && caps[k].includes("{alias}@{domain.tld}"));
  }
  check("sender-validation flag false", caps["6745385c3fc0"] === false);
}

console.log("\n[e2e] pki + verify-pubkey + profile");
{
  let r = await call("GET", "/bsvalias/id/pay@alexander.web3");
  check("pki 200 native", r.status === 200 && r.body.pubkey === PUBKEY);
  check("pki echoes handle", r.body.handle === "pay@alexander.web3");
  r = await call("GET", `/bsvalias/verify-pubkey/pay@alexander.web3/${PUBKEY}`);
  check("verify-pubkey match true", r.status === 200 && r.body.match === true);
  r = await call("GET", `/bsvalias/verify-pubkey/pay@alexander.web3/03${"ee".repeat(32)}`);
  check("verify-pubkey match false", r.status === 200 && r.body.match === false);
  r = await call("GET", "/bsvalias/public-profile/pay@alexander.web3");
  check("profile 200 with name", r.status === 200 && r.body.name.includes("alexander.web3"));
  r = await call("GET", "/bsvalias/id/nope@nothere.web3");
  check("unknown name -> 404", r.status === 404);
  r = await call("GET", "/bsvalias/id/alexander@evil.example");
  check("wrong domain -> 404", r.status === 404);
  r = await call("GET", "/bsvalias/id/someone@ordnet.io"); // house form REMOVED in v1.2
  check("house-domain form -> 404 (removed by design)", r.status === 404);
}

console.log("\n[e2e] native web3 handles (v1.1 multi-tenant)");
{
  let r = await call("GET", "/bsvalias/id/info@earthlog.web3");
  check("native handle pki 200", r.status === 200 && r.body.pubkey === PUBKEY);
  check("native handle echoed", r.body.handle === "info@earthlog.web3");
  r = await call("POST", "/bsvalias/address/info@earthlog.web3", { senderHandle: "x@handcash.io" });
  check("native handle pays domain holder", r.status === 200 && r.body.output === SCRIPT);
  r = await call("GET", "/bsvalias/public-profile/info@earthlog.web3");
  check("native profile 200", r.status === 200 && r.body.name.includes("info@earthlog.web3"));
  r = await call("POST", "/bsvalias/p2p-payment-destination/info@earthlog.web3", { satoshis: 777 });
  check("native p2p destination 200", r.status === 200 && r.body.outputs[0].script === SCRIPT);
  r = await call("GET", "/bsvalias/id/hi@fable.claude"); // TLD only in live /health list
  check("live TLD list honoured (.claude via /health)", r.status === 200);
  r = await call("GET", "/bsvalias/id/foo@bar.nl");
  check("non-web3 domain -> 404", r.status === 404);
  r = await call("GET", "/bsvalias/id/nope@nothere.web3");
  check("unregistered web3 domain -> 404", r.status === 404);
}

console.log("\n[e2e] basic address resolution");
{
  let r = await call("POST", "/bsvalias/address/pay@alexander.web3",
    { senderHandle: "someone@handcash.io", dt: new Date().toISOString(), amount: 550 });
  check("address 200", r.status === 200);
  check("output = holder script", r.body.output === SCRIPT);
  r = await call("POST", "/bsvalias/address/pay@alexander.web3", {}); // no signature, no dt
  check("unsigned request accepted (flag=false)", r.status === 200);
  r = await call("POST", "/bsvalias/address/pay@alexander.web3", { dt: "2001-01-01T00:00:00Z" });
  check("stale dt rejected", r.status === 400);
}

console.log("\n[e2e] p2p destination + receive (happy path)");
let goodRef, goodTx;
{
  let r = await call("POST", "/bsvalias/p2p-payment-destination/pay@alexander.web3", { satoshis: 10000 });
  check("p2p-dest 200", r.status === 200);
  check("one output, right script+sats", r.body.outputs?.[0]?.script === SCRIPT && r.body.outputs?.[0]?.satoshis === 10000);
  check("reference issued", typeof r.body.reference === "string" && r.body.reference.startsWith("ordnet-"));
  goodRef = r.body.reference;
  goodTx = buildTx(r.body.outputs);
  r = await call("POST", "/bsvalias/receive-transaction/pay@alexander.web3",
    { hex: goodTx, reference: goodRef, metadata: { sender: "someone@handcash.io" } });
  check("receive-tx 200", r.status === 200);
  check("txid returned matches", r.body.txid === txidOf(goodTx));
}

console.log("\n[e2e] receive negatives (§8.5)");
{
  let r = await call("POST", "/bsvalias/receive-transaction/pay@alexander.web3",
    { hex: goodTx, reference: goodRef });
  check("idempotent retry of same tx still 200", r.status === 200);

  const r2 = await call("POST", "/bsvalias/p2p-payment-destination/pay@alexander.web3", { satoshis: 5000 });
  const tampered = buildTx([{ satoshis: 4999, script: SCRIPT }]); // wrong amount
  r = await call("POST", "/bsvalias/receive-transaction/pay@alexander.web3",
    { hex: tampered, reference: r2.body.reference });
  check("tampered tx (output mismatch) -> 400", r.status === 400 && r.body.code === "output_mismatch");

  const differentTx = buildTx([{ satoshis: 10000, script: SCRIPT }], 99); // pays same outputs, different txid
  r = await call("POST", "/bsvalias/receive-transaction/pay@alexander.web3",
    { hex: differentTx, reference: goodRef });
  check("consumed reference + different tx -> 409", r.status === 409);

  r = await call("POST", "/bsvalias/receive-transaction/pay@alexander.web3",
    { hex: goodTx, reference: "ordnet-00000000-0000-0000-0000-000000000000" });
  check("unknown reference -> 404", r.status === 404);

  const r3 = await call("POST", "/bsvalias/p2p-payment-destination/pay@alexander.web3", { satoshis: 7777 });
  r = await call("POST", "/bsvalias/receive-transaction/nobody@ordnet.io",
    { hex: buildTx(r3.body.outputs), reference: r3.body.reference });
  check("reference bound to other handle -> 404", r.status === 404);

  r = await call("POST", "/bsvalias/receive-transaction/pay@alexander.web3",
    { hex: "not-hex", reference: r3.body.reference });
  check("unparseable hex -> 400", r.status === 400);

  r = await call("POST", "/bsvalias/p2p-payment-destination/pay@alexander.web3", { satoshis: -5 });
  check("negative satoshis -> 400", r.status === 400);
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
server.close(); resolver.close(); broadcaster.close();
process.exit(failed === 0 ? 0 : 1);
