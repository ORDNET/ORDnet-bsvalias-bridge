// ORDnet bsvalias bridge — configuration (all via env vars, sane defaults)
export const config = {
  // Where this bridge is publicly reachable (used inside the capability doc)
  publicBaseUrl: process.env.BRIDGE_PUBLIC_BASE_URL || "https://sns.ordnet.io",

  // v1.1 multi-tenant: native web3 handles (info@earthlog.web3). The TLD set
  // is loaded live from the resolver /health (single source, like the
  // resolver itself does with the registry); this list is only the fallback
  // until the first successful refresh.
  snsTldsFallback: (process.env.BRIDGE_SNS_TLDS || "web3,bitcoin,crypto,blockchain,ordnet,bsv,bitcoinsv")
    .split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
  tldRefreshMs: parseInt(process.env.BRIDGE_TLD_REFRESH_MS || "600000", 10),

  // SNS resolver base URL (in-proc sidecar: keep it on localhost)
  resolverBaseUrl: process.env.SNS_RESOLVER_URL || "http://127.0.0.1:8790",

  // Broadcast endpoint of ORDnet's OWN node service.
  // Expected: POST <url> with JSON {"hex": "<rawtx>"} -> {"txid": "..."}
  // Adjust broadcaster.js if your node API differs.
  broadcastUrl: process.env.BRIDGE_BROADCAST_URL || "https://api.whatsonchain.com/v1/bsv/main/tx/raw",

  // Listen
  host: process.env.BRIDGE_HOST || "127.0.0.1",
  port: parseInt(process.env.BRIDGE_PORT || "8082", 10),

  // Reference store
  referenceTtlMs: parseInt(process.env.BRIDGE_REFERENCE_TTL_MS || String(24 * 60 * 60 * 1000), 10),
  referenceFile: process.env.BRIDGE_REFERENCE_FILE || "./references.json",

  // Rate limits (per IP per minute)
  rateLimitGeneral: parseInt(process.env.BRIDGE_RATE_GENERAL || "120", 10),
  rateLimitReceiveTx: parseInt(process.env.BRIDGE_RATE_RECEIVE || "20", 10),

  // Resolver answer TTL (mirror of resolver's 300 s)
  resolverCacheMs: parseInt(process.env.BRIDGE_RESOLVER_CACHE_MS || "300000", 10),

  // Public profile
  avatarBaseUrl: process.env.BRIDGE_AVATAR_BASE_URL || "https://sns.ordnet.io/avatar",
};
