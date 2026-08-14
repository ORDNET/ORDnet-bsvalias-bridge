# ORDnet-bsvalias-bridge

[![tests](https://github.com/ORDNET/ORDnet-bsvalias-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/ORDNET/ORDnet-bsvalias-bridge/actions/workflows/test.yml)
[![test count](https://img.shields.io/badge/tests-61_passing-2b8a3e?style=flat-square)](#tests)
[![dependencies](https://img.shields.io/badge/dependencies-zero-364fc7?style=flat-square)](#run)
[![standard](https://img.shields.io/badge/implements-ODNCA--STD--009-5f3dc4?style=flat-square)](https://github.com/ORDNET/ODNCA-standards/blob/main/ODNCA-STD-009-Paymail-Compatibility-Profile.md)
[![license](https://img.shields.io/badge/license-MIT-6a737d?style=flat-square)](LICENSE)

Paymail (bsvalias) compatibility bridge for **native web3 names**: lets any
existing paymail wallet (HandCash, Centbee, ElectrumSV, RelayX, …) pay
`info@earthlog.web3` today — with its existing bsvalias client and **one
extra line of code** on the wallet side.

This is the reference implementation of
[ODNCA-STD-009 · Paymail Compatibility Profile](https://github.com/ORDNET/ODNCA-standards/blob/main/ODNCA-STD-009-Paymail-Compatibility-Profile.md),
live behind `https://sns.ordnet.io/.well-known/bsvalias`.

**Zero dependencies.** Node ≥ 20 (built-in `fetch`). No `npm install`.

**Wire-compatible with the paymail ecosystem.** The capability document
advertises the standard bsvalias 1.0 set, including the server-to-server
P2P pair under their canonical BRFC IDs — `2a40af698840`
(p2p-payment-destination) and `5f1323cddf31` (receive-transaction) — the
same capability IDs the established paymail wallets implement. A conforming
bsvalias client needs no ORDnet-specific code to complete a payment.

## What it does

The bridge serves exactly one handle form — **`mailbox@name.tld`** where the
TLD is a recognised web3 TLD (`info@earthlog.web3`). Behind the standard
bsvalias capability document (`pki`, `paymentDestination`, the P2P pair),
answers come from the on-chain name state via a conformant SNS resolver
(ODNCA-STD-001) instead of a customer database — the calling wallet cannot
tell the difference, and does not need to.

- Mailbox semantics follow the name standard: the holder of a mailbox is by
  definition the holder of the domain; an unknown mailbox still pays the
  domain holder.
- There is **no house-domain aliasing**: a web3 name is addressed as itself,
  never as an alias under someone else's domain. Any non-web3 handle domain
  answers a clean `404 unknown_domain`.
- The recognised TLD set loads **live** from the resolver `/health`
  (`tlds` + `retired_tlds`, refreshed every 10 minutes); an env fallback
  covers startup and outages.
- Identity (pki / profile / avatar) anchors on the domain name; payment
  resolution uses the full handle.

## Run

```bash
node src/server.js
```

Configuration is entirely via environment variables (defaults in
`src/config.js`):

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_PUBLIC_BASE_URL` | `https://sns.ordnet.io` | Public URL used inside the capability document |
| `SNS_RESOLVER_URL` | `http://127.0.0.1:8790` | Resolver base URL — keep on localhost / in-proc |
| `BRIDGE_SNS_TLDS` | snapshot list | Fallback TLD set until the first live `/health` refresh |
| `BRIDGE_TLD_REFRESH_MS` | `600000` | Live TLD refresh interval |
| `BRIDGE_BROADCAST_URL` | WhatsOnChain `tx/raw` | Broadcast endpoint for P2P receive |
| `BRIDGE_HOST` / `BRIDGE_PORT` | `127.0.0.1` / `8082` | Listen address (put your TLS proxy in front) |
| `BRIDGE_REFERENCE_FILE` | `./references.json` | Persistence for issued P2P references |
| `BRIDGE_REFERENCE_TTL_MS` | 24 h | Reference lifetime |
| `BRIDGE_RATE_GENERAL` / `BRIDGE_RATE_RECEIVE` | `120` / `20` | Per-IP per-minute limits |
| `BRIDGE_RESOLVER_CACHE_MS` | `300000` | Mirror of the resolver's 300 s answer TTL |
| `BRIDGE_AVATAR_BASE_URL` | `https://sns.ordnet.io/avatar` | Public-profile avatar source |

Operational notes:

- Internal fetches never follow redirects; resolver refusals never fall
  through to stale cache (negative answers are cached as negatives).
- The reference store is file-backed; swap `src/store.js` for Redis/SQLite
  when running more than one instance.
- Run behind a TLS-terminating proxy that forwards
  `/.well-known/bsvalias` and `/bsvalias/` to the bridge port.

## Try it

Against the live deployment, with nothing but curl:

```bash
curl -s https://sns.ordnet.io/.well-known/bsvalias | jq .
curl -s -X POST https://sns.ordnet.io/bsvalias/address/info@earthlog.web3 \
  -H 'content-type: application/json' -d '{}' | jq .
# -> { "output": "76a914…88ac" }  — the locking script the resolver reports
#                                    for the current on-chain holder
```

### What this bridge does and does not verify

Be aware of this before you point money at it. The bridge **forwards** what the
SNS resolver tells it. It checks that `holder_script` is well-formed hex and
then makes it the payment destination — it does **not** verify a signature over
that answer, does not check an expiry, and does not fold a merkle proof to the
committed root.

So the destination is exactly as trustworthy as the resolver connection: anyone
who can answer as the resolver, or sit between the bridge and it, can choose
where the money goes. **Run the bridge and the resolver on the same host**, or
over a channel you control, until this is closed.

Closing it properly means the resolver and the client speaking the same signed
answer format; that is a protocol change rather than a patch, and it is tracked
as an open issue. See [SECURITY.md](SECURITY.md) and
[SECURITY-FIXES-v1.3.0.md](SECURITY-FIXES-v1.3.0.md).

## Tests

```bash
npm test
# -> RESULT: 61 passed, 0 failed
```

61 tests on bare Node: handle parsing, TLD gating, capability document,
pki / paymentDestination / P2P flows, fallback disclosure, error shapes,
and rate limiting.

## Related

- [ODNCA-standards](https://github.com/ORDNET/ODNCA-standards) — STD-009 (this profile) and the full specification set
- [ORDnet-SNS-client](https://github.com/ORDNET/ORDnet-SNS-client) — native resolution with signed-answer verification (the upgrade path beyond paymail)

## License

MIT © ORDnet / ODNCA
