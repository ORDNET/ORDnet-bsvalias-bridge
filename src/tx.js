// Minimal raw-transaction parser (BSV: no segwit) — enough to
// (a) extract outputs (satoshis + locking script) and (b) compute the txid.
// Security-critical: used by receive-transaction to check the sender's tx
// really pays the destination we issued. Fail-closed on any malformation.
import { createHash } from "node:crypto";

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  need(n) {
    if (this.pos + n > this.buf.length) throw new Error("tx truncated");
    const start = this.pos; this.pos += n;
    return this.buf.subarray(start, this.pos);
  }
  u32le() { return this.need(4).readUInt32LE(0); }
  u64le() {
    const b = this.need(8);
    const v = b.readBigUInt64LE(0);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("value too large");
    return Number(v);
  }
  varint() {
    const first = this.need(1)[0];
    if (first < 0xfd) return first;
    if (first === 0xfd) return this.need(2).readUInt16LE(0);
    if (first === 0xfe) return this.u32le();
    const v = this.need(8).readBigUInt64LE(0);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("varint too large");
    return Number(v);
  }
}

function sha256d(buf) {
  const a = createHash("sha256").update(buf).digest();
  return createHash("sha256").update(a).digest();
}

/**
 * Parse a raw transaction hex string.
 * @returns {{ txid: string, outputs: Array<{satoshis:number, script:string}> }}
 * @throws on any malformed input (caller must treat as 400)
 */
export function parseTx(hex) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error("invalid hex");
  }
  const raw = Buffer.from(hex, "hex");
  const r = new Reader(raw);

  r.u32le(); // version

  const vinCount = r.varint();
  if (vinCount === 0) throw new Error("no inputs");
  for (let i = 0; i < vinCount; i++) {
    r.need(36);                 // prev txid (32) + vout (4)
    const scriptLen = r.varint();
    r.need(scriptLen);          // unlocking script
    r.need(4);                  // sequence
  }

  const voutCount = r.varint();
  if (voutCount === 0) throw new Error("no outputs");
  const outputs = [];
  for (let i = 0; i < voutCount; i++) {
    const satoshis = r.u64le();
    const scriptLen = r.varint();
    const script = r.need(scriptLen).toString("hex");
    outputs.push({ satoshis, script });
  }

  r.need(4); // locktime
  if (r.pos !== raw.length) throw new Error("trailing bytes");

  const txid = Buffer.from(sha256d(raw)).reverse().toString("hex");
  return { txid, outputs };
}

/**
 * Check that every issued output (script+satoshis) appears in the tx,
 * counting multiplicity (two identical issued outputs need two matches).
 */
export function txPaysOutputs(parsedTx, issuedOutputs) {
  const pool = parsedTx.outputs.map((o) => `${o.satoshis}:${o.script.toLowerCase()}`);
  for (const issued of issuedOutputs) {
    const key = `${issued.satoshis}:${issued.script.toLowerCase()}`;
    const idx = pool.indexOf(key);
    if (idx === -1) return false;
    pool.splice(idx, 1);
  }
  return true;
}
