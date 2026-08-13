# Security fixes — ORDnet bsvalias bridge v1.3.0

**Audit:** external GitHub review of 13 August 2026
**Supersedes:** v1.2.1

## Malformed percent-escapes answered 500

`GET /bsvalias/id/%ZZ` returned a 500, because two `decodeURIComponent` calls
sat outside any try/catch. The Merkle-Resolver fixed exactly this class in its
v1.0.1 and this repository kept the raw calls — the review found one, and there
were two: `parsePaymail` (which every handle route goes through) and the pubkey
route. A third `decodeURIComponent` lives in the test harness, which is
harmless and stays.

`safeDecode()` returns `null` instead of throwing, with a 2100-character cap per
SNS-NAME-1, and every caller turns that into a 400.

That the same fix landed in one repository and not the other is the clearest
argument for extracting a shared core — the code is byte-identical.

## Tests

61, up from 55. Six new cases fire malformed escapes at two decoding routes and assert
the bridge still answers `/.well-known/bsvalias` afterwards.

## Still open

The review's point 2.8 — the bridge takes `holder_script` from the resolver,
checks only that it is hex, and makes it the payment destination, with no
signature, no `expires` and no merkle fold — is **not** fixed here. Closing it
properly means calling `verifyAnswer`/`verifyProof` on the resolver's response,
which requires the resolver and the client to speak the same answer format
first (review point 3.3). That is a protocol change, not a patch, and rushing
it would give a false sense of verification. Until then the deployment note
stands: keep the bridge and the resolver on the same host.

