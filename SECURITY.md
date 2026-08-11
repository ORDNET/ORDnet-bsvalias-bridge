# Security Policy

## Reporting a vulnerability

Please report security issues privately first. Do not open a public issue for
anything that could put funds or names at risk.

**Preferred channel:** [GitHub private vulnerability reporting](https://github.com/ORDNET/ORDnet-bsvalias-bridge/security/advisories/new)
— the "Report a vulnerability" button on the Security tab of this repository.
This creates a private advisory only the maintainers can see.

Please include what the issue is, which file and line, how to reproduce it,
and what an attacker gains.

## What to expect

- **Acknowledgement:** within 3 working days.
- **Assessment:** within 10 working days, with a severity.
- **Credit:** we will name you in the release notes unless you prefer otherwise.

We do not currently operate a bug bounty.

## Threat model

This bridge sits between paymail wallets and on-chain names, and it reports
back to a sender whether their payment went through. Two things carry the
weight:

1. **A broadcast result must be truthful.** Telling a sender "received" when no
   transaction reached the network is worse than an error: the payment
   reference is consumed, the sender believes they have paid, and the recipient
   has nothing. An upstream failure must always surface as a failure.
2. **The answer must come from the resolver, not from the bridge.** The bridge
   forwards what the SNS resolver says; it does not invent destinations. A way
   to make it answer with a script the resolver did not sign is a
   vulnerability.

Out of scope: the upstream broadcaster's availability, and any hosted
deployment operated by someone else.

## Known history

Version 1.2.0 and earlier treated any upstream response containing the
substring `known` as a successful broadcast. Because `unknown` contains
`known`, every upstream error carrying that word — a gateway error page, an
"unknown host" reply, a 500 — was reported to the sender as a completed
payment while no transaction existed. Fixed in **1.2.1**. See
[SECURITY-FIXES-v1.2.1.md](SECURITY-FIXES-v1.2.1.md).
