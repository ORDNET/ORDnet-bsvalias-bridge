# Changelog — ORDnet bsvalias bridge

All notable changes to the paymail-compatibility bridge.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.2.1] — 2026-08-11 — security release

### Security

- **An upstream failure could be reported as a completed payment.** The
  idempotency check matched the substring `known`, and `unknown` contains it,
  so any upstream error carrying that word returned a txid: the sender was told
  the payment went through, the reference was consumed, and nothing had been
  broadcast. Matching is now on whole phrases.
  See [SECURITY-FIXES-v1.2.1.md](SECURITY-FIXES-v1.2.1.md).

### Added

- Six regression tests (49 → 55), five firing failing upstreams and one
  confirming a genuine duplicate still returns its txid.
- `SECURITY.md`.

### Fixed

- The suite's summary line printed before the last block ran, so the reported
  count was short of the real one.

---

## [1.2.0] — 2026-08-09 — native-only

### Changed

- **BREAKING:** the `@ordnet.io` house address is removed. The bridge serves
  native web3 handles only (`mailbox@name.tld`); `someone@ordnet.io` now
  returns `404 unknown_domain`.
- The TLD set is read live from the resolver's `/health`, with an env fallback.

---

## [1.0.1] — 2026-08 — initial public release

Zero-dependency bsvalias/paymail bridge over the SNS resolver: capability
document, p2p payment destination, receive-transaction, P2P references.
