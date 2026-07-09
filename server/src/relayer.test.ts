import { describe, it, expect, vi, beforeEach } from "vitest";
import { Interface, getAddress } from "ethers";
import { buildSelectorAllowlist, MARKET_RELAY_ABI, RateLimiter, createRelayer } from "./relayer.js";
import { MAFIA_MARKET_ABI } from "./abi.js";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

// Shared recorders for the mocked-chain tests below. Hoisted so the vi.mock("ethers") factory (which is
// hoisted above the imports) can close over them.
const h = vi.hoisted(() => ({
  /** Ordered send/wait lifecycle events, timestamped, tagged by the request's `from`. */
  timeline: [] as { t: number; e: "send-start" | "send-end" | "wait-start" | "wait-end"; id: string }[],
  /** NonceManager.reset spy — shared across every relayer instance built in these tests. */
  resetSpy: vi.fn(),
  /** `from` addresses whose (mocked) broadcast should throw, to exercise the reset-on-failure path. */
  failFor: new Set<string>(),
  /** Fake network delays: the broadcast (send) is short, the mine (wait) is long, so a serialized send
   *  followed by a parallel wait is easy to distinguish from the old wait-inside-the-lock behaviour. */
  sendMs: 15,
  mineMs: 60,
}));

// Mock only the chain-touching ethers surface (provider/wallet/nonce-manager/contract); keep the pure
// helpers (Interface/getAddress/formatEther) real so the allowlist + address handling behave for real.
vi.mock("ethers", async (importActual) => {
  const actual = (await importActual()) as typeof import("ethers");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();

  class MockProvider {
    constructor(_url: string, _chainId: number) {}
    async getBalance() {
      return 10n ** 18n; // 1 0G — comfortably above the funded floor
    }
  }
  class MockWallet {
    address = getAddress("0x" + "4".repeat(40));
    provider: unknown;
    constructor(_pk: string, provider: unknown) {
      this.provider = provider;
    }
  }
  class MockNonceManager {
    reset = h.resetSpy;
    constructor(public signer: unknown) {}
  }
  class MockContract {
    constructor(_addr: string, _abi: unknown, _runner: unknown) {}
    getFunction(name: string) {
      if (name === "betToken") return async () => getAddress("0x" + "5".repeat(40));
      if (name === "verify") return async () => true;
      if (name === "execute") {
        return async (req: { from: string }) => {
          const id = req.from;
          h.timeline.push({ t: now(), e: "send-start", id });
          await sleep(h.sendMs);
          h.timeline.push({ t: now(), e: "send-end", id });
          if (h.failFor.has(id)) throw new Error("broadcast boom");
          return {
            hash: `0xtx-${id}`,
            async wait() {
              h.timeline.push({ t: now(), e: "wait-start", id });
              await sleep(h.mineMs);
              h.timeline.push({ t: now(), e: "wait-end", id });
              return { hash: `0xrc-${id}` };
            },
          };
        };
      }
      return async () => {
        throw new Error(`unexpected mocked call: ${name}`);
      };
    }
  }

  return {
    ...actual,
    JsonRpcProvider: MockProvider,
    Wallet: MockWallet,
    NonceManager: MockNonceManager,
    Contract: MockContract,
  };
});

describe("relayer — sponsored-selector allowlist", () => {
  const allow = buildSelectorAllowlist();
  const relay = new Interface(MARKET_RELAY_ABI);
  const host = new Interface(MAFIA_MARKET_ABI); // server/abi.ts: the owner/host surface

  it("sponsors exactly the bettor actions (betProp/claimProp/refundProp/batchClaim/batchRefund/enterRefundMode) + faucet/approve", () => {
    // Every market is a categorical prop, so there is ONE bet/claim/refund surface to sponsor — plus the
    // batch collect-all mirrors so a one-tap "Collect all" can be relayed gaslessly too.
    for (const fn of ["betProp", "claimProp", "refundProp", "batchClaim", "batchRefund", "enterRefundMode"]) {
      expect(allow.get(relay.getFunction(fn)!.selector), fn).toBe(fn);
    }
    // faucet + approve are token selectors — present by label.
    expect([...allow.values()]).toContain("faucet");
    expect([...allow.values()]).toContain("approve");
  });

  it("never sponsors owner/host functions (createMatch, settle, lockBetting, open*Round, openDetectiveClaim, openMafiaSeatMarket, openFactionMarket, closeProp)", () => {
    for (const fn of ["createMatch", "settle", "lockBetting", "openVotedOutRound", "openNightKillRound", "openDetectiveClaim", "openMafiaSeatMarket", "openFactionMarket", "closeProp"]) {
      expect(allow.has(host.getFunction(fn)!.selector), fn).toBe(false);
    }
  });

  it("never sponsors a transferFrom (would let a relay move someone else's CHIP)", () => {
    const transferFrom = new Interface(["function transferFrom(address,address,uint256) returns (bool)"]).getFunction("transferFrom")!.selector;
    expect(allow.has(transferFrom)).toBe(false);
  });
});

describe("relayer — per-address rate limiter", () => {
  it("allows up to the burst, then blocks until refilled", async () => {
    const rl = new RateLimiter(3, 20); // burst 3, refill 1 token / 20ms
    expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(false); // burst exhausted
    await new Promise((r) => setTimeout(r, 40)); // ~2 tokens refilled
    expect(rl.take("a")).toBe(true);
  });

  it("tracks buckets independently per address", () => {
    const rl = new RateLimiter(1, 10_000);
    expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(false); // a is spent
    expect(rl.take("b")).toBe(true); // b is independent
  });
});

describe("relayer — pipelined submission (serialize the send, parallelize the mine)", () => {
  const MARKET = getAddress("0x" + "1".repeat(40));
  const FORWARDER = getAddress("0x" + "2".repeat(40));
  const betData = new Interface(MARKET_RELAY_ABI).encodeFunctionData("betProp", [1, 0, 0, 10]);

  /** Highest number of intervals of one lifecycle phase (send or wait) that overlap at any instant.
   *  Touching intervals (one ends exactly as the next starts) don't count — ends are processed before
   *  starts at an equal timestamp. */
  function maxConcurrency(startE: string, endE: string): number {
    const pts = h.timeline
      .filter((x) => x.e === startE || x.e === endE)
      .map((x) => ({ t: x.t, d: x.e === startE ? 1 : -1 }))
      .sort((a, b) => a.t - b.t || a.d - b.d); // at equal t, -1 (end) before +1 (start)
    let cur = 0;
    let max = 0;
    for (const p of pts) {
      cur += p.d;
      if (cur > max) max = cur;
    }
    return max;
  }

  function makeRelayer(onSponsoredWrite?: (m: number) => void) {
    return createRelayer({
      rpcUrl: "http://mock",
      chainId: 1,
      relayerPrivateKey: "0x" + "1".repeat(64),
      forwarderAddress: FORWARDER,
      marketAddress: MARKET,
      onSponsoredWrite,
    })!;
  }

  /** Drive one POST /relay through the real handle() with a from address; resolves to { status, body }. */
  async function post(relayer: ReturnType<typeof makeRelayer>, from: string) {
    const req = new EventEmitter() as EventEmitter & IncomingMessage;
    req.method = "POST";
    req.url = "/relay";
    const request = { from, to: MARKET, value: "0", gas: "600000", nonce: "0", deadline: "99999999999", data: betData };
    // Emit the body after handle() has attached its stream listeners.
    setImmediate(() => {
      req.emit("data", JSON.stringify({ request, signature: "0xdeadbeef" }));
      req.emit("end");
    });
    let status = 0;
    let body: any;
    const res = {
      writeHead(s: number) {
        status = s;
        return res;
      },
      end(b?: string) {
        body = b ? JSON.parse(b) : undefined;
      },
    } as unknown as ServerResponse;
    await relayer.handle(req, res);
    return { status, body };
  }

  beforeEach(() => {
    h.timeline.length = 0;
    h.resetSpy.mockClear();
    h.failFor.clear();
  });

  it("serializes the broadcast (one at a time) but mines concurrent relays in parallel", async () => {
    const bumped: number[] = [];
    const relayer = makeRelayer((m) => bumped.push(m));
    const froms = ["a1", "a2", "a3"].map((s) => getAddress("0x" + s.padStart(40, "0")));

    const results = await Promise.all(froms.map((f) => post(relayer, f)));

    // All three mined and returned their receipt hash.
    for (const r of results) expect(r.status).toBe(200);
    expect(new Set(results.map((r) => r.body.txHash))).toEqual(new Set(froms.map((f) => `0xrc-${f}`)));

    // Sends never overlap — the single relayer wallet's nonces can't race.
    expect(maxConcurrency("send-start", "send-end")).toBe(1);
    // Mines DO overlap — the whole point of the change (was 1 with wait() inside the lock).
    expect(maxConcurrency("wait-start", "wait-end")).toBeGreaterThanOrEqual(2);

    // Each landed betProp signalled the live-book pusher with the decoded matchId.
    expect(bumped).toEqual([1, 1, 1]);
  });

  it("resets the nonce manager when a broadcast fails, so a consumed nonce can't wedge the relayer", async () => {
    const relayer = makeRelayer();
    const from = getAddress("0x" + "b1".padStart(40, "0"));
    h.failFor.add(from);

    const { status, body } = await post(relayer, from);

    expect(status).toBe(500);
    expect(body.error).toContain("broadcast boom");
    expect(h.resetSpy).toHaveBeenCalledTimes(1);
  });
});
