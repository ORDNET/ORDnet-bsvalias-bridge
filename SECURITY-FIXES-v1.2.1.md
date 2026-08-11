# Security fixes — ORDnet bsvalias bridge v1.2.1

**Released:** 11 August 2026
**Supersedes:** v1.2.0

## H1 — An upstream failure was reported to the sender as a completed payment

**Was**, in `src/services.js`:

```js
const msg = raw.toLowerCase();
if (msg.includes("already") || msg.includes("known") || msg.includes("txn-already")) {
  return expectedTxid; // idempotent: it's on the network, that's success
}
```

The intent was correct — a broadcaster that answers "already in the mempool"
has the transaction, and that is success. The implementation matched substrings.

**`"unknown".includes("known")` is `true`.**

So every upstream response with the word *unknown* anywhere in it was read as a
successful broadcast: a Cloudflare error page, a 500 saying `unknown host`, a
`404 unknown method`, a gateway complaining about an unknown backend. The
reviewer reproduced it with a `500 "unknown host"` and got a txid back.

The consequence is worse than a failed payment. The sender is told the
transaction went through, the recipient's wallet reports it as received, the
payment reference is consumed — and nothing was ever broadcast. The failure is
silent on every side.

**Now:** whole phrases, not substrings.

```js
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
```

None of these appears in an error page that merely uses the word *unknown*.

### One thing worth knowing about the fix

The first version of this patch also required `res.ok` — an HTTP error, the
reasoning went, is never a success. That was wrong, and the existing test suite
caught it: **a genuine duplicate legitimately arrives with a non-2xx status.**
WhatsOnChain answers a re-broadcast with `409 txn-already-known`. Requiring a
2xx would have broken idempotency, and a retried payment would have failed
where it used to succeed.

So the status is deliberately not part of the test. The phrase list does the
work, plus a check that we actually have an expected txid to return. The
comment in the code says so, because it is the kind of thing a later reader
would otherwise "fix" back.

## Tests

```bash
node test/run-tests.js
```

**55 tests**, up from 49. Six are new:

- five that arm the mock broadcaster with a failing upstream — `500 unknown
  host`, `502 Error: unknown`, a `503` HTML page mentioning *Unknown backend*,
  `404 unknown method`, and a plain `500 internal server error` — and assert
  each one comes back as a failure with no txid
- one that arms it with `409 txn-already-known` and asserts the txid still
  comes back, so the idempotency this whole branch exists for keeps working

The mock gained a small hook (`broadcasterFailure`) so a test can make it
behave like a broken upstream rather than a broadcaster. The summary line at
the end of the suite also moved: it was printing before the last block ran, so
the reported count was short of the real one.

## Not changed

`src/resolve.js`, the handle grammar, the capability document and the
well-known routes are untouched. Wire behaviour for a successful payment is
identical to v1.2.0.
