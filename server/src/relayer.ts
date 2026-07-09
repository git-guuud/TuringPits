/**
 * Optional EIP-2771 gas relayer (the "gasless" path).
 *
 * A spectator with ZERO native 0G signs a ForwardRequest off-chain (free); this relayer submits it
 * through the trusted Forwarder and pays the gas. The user stays the on-chain bettor — `_msgSender()`
 * resolves to them — so stakes/claims belong to the user, not the relayer. See contracts/Forwarder.sol
 * and lib/ERC2771Context.sol.
 *
 * OPTIONAL at every layer: this module only activates when `RELAYER_PRIVATE_KEY` + `FORWARDER_ADDRESS`
 * are set. Otherwise `/relay/info` reports `enabled:false` and the frontend keeps the direct
 * (user-pays-gas) path. The relayer auto-reports `funded` (does its wallet still hold 0G?) so the
 * frontend can fall back to direct ONLY when the relayer is broke — never because the user is.
 *
 * Routes (mounted by index.ts on the same HTTP port as the WebSocket hub):
 *   GET  /relay/info  → { enabled, forwarder, market, token, relayer, chainId, funded, relayerBalance }
 *   POST /relay       → { txHash }   body: { request: ForwardRequest, signature: hex }
 *
 * Abuse-gating (it spends the host's real testnet 0G): allowlisted target contracts + function
 * selectors, value must be 0, a gas cap, an on-chain `verify()` pre-check (so we never submit a
 * doomed tx), a per-`from` token-bucket rate limit, and serialized broadcast (one send at a time, via a
 * local NonceManager) so the relayer wallet's nonces never race while relays still mine in parallel.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Contract, JsonRpcProvider, Wallet, NonceManager, Interface, formatEther, getAddress } from "ethers";

const FORWARDER_ABI = [
  "function getNonce(address from) view returns (uint256)",
  "function verify((address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data) req, bytes signature) view returns (bool)",
  "function execute((address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data) req, bytes signature) payable returns (bool, bytes)",
];

/**
 * The MafiaMarket BETTOR surface the relayer sponsors (distinct from server/abi.ts, which is the
 * host/owner surface). Used to compute the sponsored function selectors + read the CHIP token; the
 * relayer deliberately does NOT know about owner functions (createMatch/settle/...), so they can
 * never be relayed.
 */
export const MARKET_RELAY_ABI = [
  // Every market (headline faction + side) is one categorical prop, so there is a SINGLE bet/claim/refund
  // surface to sponsor — betProp/claimProp/refundProp — plus the batch collect-all mirrors (batchClaim/
  // batchRefund) and the permissionless refund-mode flip.
  "function betProp(uint256 matchId, uint256 propIdx, uint8 outcome, uint128 amount)",
  "function claimProp(uint256 matchId, uint256 propIdx)",
  "function refundProp(uint256 matchId, uint256 propIdx)",
  "function batchClaim(uint256 matchId, uint256[] propIdxs)",
  "function batchRefund(uint256 matchId, uint256[] propIdxs)",
  "function enterRefundMode(uint256 matchId)",
  "function betToken() view returns (address)",
];

// Minimal CHIP (MockBetToken) surface — only the selectors the relayer needs to recognize.
const TOKEN_ABI = [
  "function faucet()",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

/** The only contract calls the relayer will sponsor — selector => human label (for logs/errors). */
export function buildSelectorAllowlist(): Map<string, string> {
  const market = new Interface(MARKET_RELAY_ABI);
  const token = new Interface(TOKEN_ABI);
  const allow = new Map<string, string>();
  const add = (iface: Interface, name: string) => allow.set(iface.getFunction(name)!.selector, name);
  // market: place + claim + refund wagers on any market (all are props), the one-tap batch collect-all,
  // and the permissionless refund flip.
  for (const fn of ["betProp", "claimProp", "refundProp", "batchClaim", "batchRefund", "enterRefundMode"]) add(market, fn);
  // token: mint test CHIP + approve the market to pull it.
  for (const fn of ["faucet", "approve"]) add(token, fn);
  return allow;
}

export interface RelayerConfig {
  rpcUrl: string;
  chainId: number;
  relayerPrivateKey: string;
  forwarderAddress: string;
  marketAddress: string;
  /** Max gas a single relayed inner call may request. Default 700k (covers approve+bet+claim). */
  gasCap?: bigint;
  /** Token-bucket: burst size + refill interval (ms) per `from` address. */
  rateBurst?: number;
  rateRefillMs?: number;
  /** Below this native-0G balance the relayer reports `funded:false` and refuses new relays. */
  minRelayerBalanceWei?: bigint;
  /**
   * Called the instant a sponsored `betProp` lands on-chain, with the bet's matchId. The server wires
   * this to the running match's pool pusher so the odds update in real time (~as fast as the bet mines)
   * instead of on the orchestrator's backstop poll. See pool-signal.ts. No-op if unset.
   */
  onSponsoredWrite?: (matchId: number) => void;
}

interface ForwardRequest {
  from: string;
  to: string;
  value: bigint;
  gas: bigint;
  nonce: bigint;
  deadline: bigint;
  data: string;
}

/** A simple per-key token bucket. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();
  constructor(private readonly burst: number, private readonly refillMs: number) {}
  take(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, last: now };
    // Refill based on elapsed time.
    const refilled = Math.min(this.burst, b.tokens + (now - b.last) / this.refillMs);
    if (refilled < 1) {
      this.buckets.set(key, { tokens: refilled, last: now });
      return false;
    }
    this.buckets.set(key, { tokens: refilled - 1, last: now });
    return true;
  }
}

export interface Relayer {
  /** Try to handle an HTTP request; returns true if it owned the route (else the caller falls through). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  readonly relayerAddress: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limitBytes) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Build the relayer if it's configured, else return null (the feature stays off and the frontend
 * keeps the direct path). Reads the bet token from the market on first use.
 */
export function createRelayer(cfg: RelayerConfig): Relayer | null {
  if (!cfg.relayerPrivateKey || !cfg.forwarderAddress) {
    console.log("[relayer] disabled (set RELAYER_PRIVATE_KEY + FORWARDER_ADDRESS to enable gasless betting)");
    return null;
  }

  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const wallet = new Wallet(cfg.relayerPrivateKey, provider);
  // A NonceManager assigns nonces from a LOCAL counter instead of re-reading the pending count from the
  // RPC before each send. That's what lets the single relayer wallet PIPELINE — broadcast tx N+1 while
  // tx N is still mining — without the RPC's just-submitted-tx lag handing two serialized sends the same
  // nonce. `wallet` is kept for reads (address/balance); writes go through `signer`.
  const signer = new NonceManager(wallet);
  const forwarder = new Contract(cfg.forwarderAddress, FORWARDER_ABI, signer);
  const forwarderAddr = getAddress(cfg.forwarderAddress);
  const marketAddr = getAddress(cfg.marketAddress);

  const gasCap = cfg.gasCap ?? 700_000n;
  const minBalance = cfg.minRelayerBalanceWei ?? 10_000_000_000_000_000n; // 0.01 0G
  const selectors = buildSelectorAllowlist();
  const marketIface = new Interface(MARKET_RELAY_ABI); // decode a landed betProp's matchId for the pool signal
  const limiter = new RateLimiter(cfg.rateBurst ?? 6, cfg.rateRefillMs ?? 6_000);
  const inflight = new Set<string>(); // per-`from` lock: one pending relay each

  // The market's bet token (CHIP) — read once, then memoized; it's the 2nd allowlisted target.
  let tokenAddrPromise: Promise<string> | null = null;
  const tokenAddress = (): Promise<string> => {
    if (!tokenAddrPromise) {
      const market = new Contract(marketAddr, MARKET_RELAY_ABI, provider);
      tokenAddrPromise = market
        .getFunction("betToken")()
        .then((a: string) => getAddress(a))
        .catch((e: unknown) => {
          tokenAddrPromise = null; // don't memoize a transient RPC failure
          throw e;
        });
    }
    return tokenAddrPromise;
  };

  // Serialize only the SEND (nonce assignment + broadcast) so the relayer wallet's nonces never race
  // under concurrent requests. The receipt is awaited OUTSIDE this queue (see relay()), so the queue
  // advances the instant a tx is broadcast — letting concurrent relays mine in parallel rather than
  // clearing one-mined-tx-at-a-time.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {}); // keep the chain alive on failures
    return run;
  };

  console.log(`[relayer] enabled — wallet=${wallet.address} forwarder=${forwarderAddr}`);

  async function info() {
    const token = await tokenAddress().catch(() => null);
    const bal = await provider.getBalance(wallet.address).catch(() => 0n);
    return {
      enabled: true,
      forwarder: forwarderAddr,
      market: marketAddr,
      token,
      relayer: wallet.address,
      chainId: cfg.chainId,
      funded: bal >= minBalance,
      relayerBalance: formatEther(bal),
    };
  }

  /** Validate, then submit. Throws { status, message } on rejection. */
  async function relay(raw: unknown): Promise<{ txHash: string }> {
    const body = raw as { request?: any; signature?: unknown };
    if (!body?.request || typeof body.signature !== "string") {
      throw { status: 400, message: "expected { request, signature }" };
    }
    const r = body.request;
    let req: ForwardRequest;
    try {
      req = {
        from: getAddress(String(r.from)),
        to: getAddress(String(r.to)),
        value: BigInt(r.value ?? 0),
        gas: BigInt(r.gas),
        nonce: BigInt(r.nonce),
        deadline: BigInt(r.deadline),
        data: String(r.data),
      };
    } catch {
      throw { status: 400, message: "malformed request fields" };
    }
    const signature = body.signature;

    // 1. Target allowlist — only the market or its CHIP token.
    const token = await tokenAddress();
    if (req.to !== marketAddr && req.to !== token) throw { status: 403, message: "target not allowed" };

    // 2. Selector allowlist — only the sponsored bet/claim/faucet/approve calls.
    const selector = req.data.slice(0, 10).toLowerCase();
    const label = selectors.get(selector);
    if (!label) throw { status: 403, message: "function not allowed" };

    // 3. No value, bounded gas.
    if (req.value !== 0n) throw { status: 400, message: "value must be 0" };
    if (req.gas <= 0n || req.gas > gasCap) throw { status: 400, message: "gas out of range" };

    // 4. Per-`from` rate limit + single-in-flight lock.
    if (inflight.has(req.from)) throw { status: 429, message: "a relay is already in flight for this address" };
    if (!limiter.take(req.from)) throw { status: 429, message: "rate limit — slow down" };

    // 5. Relayer must still have gas to pay (else tell the client to fall back to the direct path).
    const bal = await provider.getBalance(wallet.address);
    if (bal < minBalance) throw { status: 503, message: "relayer out of gas — use your own wallet" };

    // 6. On-chain validity pre-check (signature/nonce/deadline) so we never submit a reverting tx.
    const ok = (await forwarder.getFunction("verify")(req, signature)) as boolean;
    if (!ok) throw { status: 400, message: "invalid or expired signature" };

    // 7. Submit, then wait for the receipt. Only the SEND is serialized (via enqueue) so the single
    //    relayer wallet's nonces never race; the mine is awaited OUTSIDE the queue so concurrent relays
    //    pipeline into consecutive blocks instead of the whole fleet clearing one-mined-tx-at-a-time.
    inflight.add(req.from);
    try {
      const tx = await enqueue(async () => {
        try {
          const sent = await forwarder.getFunction("execute")(req, signature, { gasLimit: req.gas + 120_000n });
          console.log(`[relayer] ${label} for ${req.from} → ${sent.hash}`);
          return sent;
        } catch (e) {
          // A failed broadcast may have consumed a local nonce without ever landing a mempool tx — drop
          // the cached delta so the NEXT send re-syncs its nonce from chain rather than leaving a
          // permanent gap that wedges every subsequent relay. reset() runs inside the serialized send,
          // so it's ordered before the next queued broadcast reads a nonce.
          signer.reset();
          throw e;
        }
      });
      // Await the receipt OUTSIDE the serialized send so many relays mine concurrently. We still respond
      // only after it's mined, so the client's "tx is mined on response" contract is unchanged.
      const receipt = await tx.wait();
      // A bet just moved the book — tell the server so it re-reads + broadcasts the live pools NOW,
      // rather than making spectators wait for the orchestrator's backstop poll. Only betProp changes
      // OPEN-market odds (claims/refunds are post-settle), so that's the only call we signal on.
      if (label === "betProp") {
        try {
          const matchId = Number(marketIface.decodeFunctionData("betProp", req.data)[0]);
          cfg.onSponsoredWrite?.(matchId);
        } catch {
          /* non-fatal — the backstop poll still catches the change */
        }
      }
      return { txHash: receipt?.hash ?? "" };
    } finally {
      inflight.delete(req.from);
    }
  }

  return {
    relayerAddress: wallet.address,
    async handle(httpReq, res) {
      const url = (httpReq.url ?? "").split("?")[0];
      if (url !== "/relay" && url !== "/relay/info") return false;

      if (httpReq.method === "OPTIONS") {
        res.writeHead(204, CORS);
        res.end();
        return true;
      }
      if (url === "/relay/info" && httpReq.method === "GET") {
        sendJson(res, 200, await info());
        return true;
      }
      if (url === "/relay" && httpReq.method === "POST") {
        try {
          const parsed = JSON.parse(await readBody(httpReq));
          const out = await relay(parsed);
          sendJson(res, 200, out);
        } catch (e: any) {
          const status = typeof e?.status === "number" ? e.status : 500;
          const message = e?.message ?? "relay failed";
          if (status >= 500) console.error("[relayer] error:", e);
          sendJson(res, status, { error: message });
        }
        return true;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    },
  };
}
