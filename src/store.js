// Reference store for the P2P pair (5.5 issues, 5.6 consumes).
// Single-use, handle-bound, TTL-bound. File-backed so a restart doesn't
// strand in-flight payments. For multi-instance deployments swap this for
// Redis/SQLite — the interface is four functions.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

export class ReferenceStore {
  constructor({ ttlMs, file }) {
    this.ttlMs = ttlMs;
    this.file = file;
    this.map = new Map(); // reference -> { handle, outputs, createdAt, consumed }
    this._load();
    // periodic cleanup + persist
    this.timer = setInterval(() => { this._sweep(); this._persist(); }, 60_000);
    this.timer.unref?.();
  }

  issue(handle, outputs) {
    const reference = `ordnet-${randomUUID()}`;
    this.map.set(reference, { handle, outputs, createdAt: Date.now(), consumed: false });
    this._persist();
    return reference;
  }

  /** Returns the entry if valid for this handle and unexpired, else null. */
  peek(reference, handle) {
    const e = this.map.get(reference);
    if (!e) return null;
    if (e.handle !== handle) return null;
    if (Date.now() - e.createdAt > this.ttlMs) return null;
    return e;
  }

  /** Marks consumed (idempotent broadcast handling is the caller's job). */
  consume(reference) {
    const e = this.map.get(reference);
    if (e) { e.consumed = true; this._persist(); }
  }

  _sweep() {
    const now = Date.now();
    for (const [k, e] of this.map) {
      if (now - e.createdAt > this.ttlMs) this.map.delete(k);
    }
  }

  _persist() {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.map.entries()]), "utf8");
      renameSync(tmp, this.file);
    } catch { /* best effort; in-memory copy remains authoritative */ }
  }

  _load() {
    try {
      if (!existsSync(this.file)) return;
      const entries = JSON.parse(readFileSync(this.file, "utf8"));
      this.map = new Map(entries);
      this._sweep();
    } catch { this.map = new Map(); }
  }
}
