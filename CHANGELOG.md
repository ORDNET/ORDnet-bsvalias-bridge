# Changelog — ORDnet bsvalias bridge

All notable changes to the paymail-compatibility bridge.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.3.1] — 2026-08-13 — documentation

- The `holder_script` trust boundary is now stated in the README where an
  operator will actually read it: the bridge takes the payment destination
  from the resolver on trust (well-formed hex is the only check — no
  signature, no `expires`, no merkle fold), so the bridge and the resolver
  must run on the same host until the shared answer format lands. No code
  changes in this release.

## [1.3.0] — 2026-08-13 — audit round 2

Second round of the external review. Full detail in
[SECURITY-FIXES-v1.3.0.md](SECURITY-FIXES-v1.3.0.md).

### Security

- **Malformed percent-escapes answered 500.** `GET /bsvalias/id/%ZZ` hit a
  raw `decodeURIComponent` outside any try/catch — the exact class the
  Merkle-Resolver fixed in its v1.0.1, still present here in two places
  (`parsePaymail`, which every handle route goes through, and the pubkey
  route). `safeDecode()` now returns `null` instead of throwing, with a
  2100-character cap per SNS-NAME-1, and every caller turns that into a 400.
  That the same fix landed in one repository and not the other is the
  clearest argument for extracting `@ordnet/sns-core`.

### Known issue (documented, not fixed)

- Review point 2.8: the bridge pays to `holder_script` from the resolver
  without verification. Closing it properly means `verifyAnswer`/`verifyProof`
  on the resolver's response, which first requires resolver and client to
  speak the same answer format (point 3.3) — a protocol change, not a patch.
  Deployment note: keep bridge and resolver on the same host.

### Tests

- 61, up from 55: six new cases fire malformed escapes at both decoding
  routes and assert the bridge still answers `/.well-known/bsvalias`.

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
