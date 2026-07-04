import { describe, it, expect } from "vitest";
import { Interface } from "ethers";
import { buildSelectorAllowlist, MARKET_RELAY_ABI, RateLimiter } from "./relayer.js";
import { MAFIA_MARKET_ABI } from "./abi.js";

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
