import { describe, expect, it } from "vitest";
import { toProviderSeed, estimateCallTokens, rateLimitBackoffMs } from "./zerog.js";

const MAX_INT32 = 0x7fffffff; // 2_147_483_647

describe("toProviderSeed", () => {
  it("passes through in-range integers unchanged", () => {
    expect(toProviderSeed(0)).toBe(0);
    expect(toProviderSeed(42)).toBe(42);
    expect(toProviderSeed(MAX_INT32)).toBe(MAX_INT32);
  });

  it("masks uint32 values above 2^31-1 into range (the bug case)", () => {
    expect(toProviderSeed(0xffffffff)).toBe(MAX_INT32); // 4_294_967_295 → 2_147_483_647
    expect(toProviderSeed(3_000_000_000)).toBe(3_000_000_000 & 0x7fffffff);
  });

  it("always yields a non-negative signed-32-bit integer", () => {
    for (const v of [0, 1, MAX_INT32, 0x80000000, 0xffffffff, 2_500_000_000, 123.9, -5]) {
      const out = toProviderSeed(v);
      expect(Number.isInteger(out)).toBe(true);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(MAX_INT32);
    }
  });

  it("truncates floats to an integer", () => {
    expect(toProviderSeed(123.9)).toBe(123);
  });
});

describe("estimateCallTokens", () => {
  it("approximates input+output tokens from prompt length (≈4 chars/token + completion)", () => {
    expect(estimateCallTokens("")).toBe(100); // just the completion allowance
    expect(estimateCallTokens("a".repeat(4000))).toBe(1000 + 100); // 4000/4 + 100
  });

  it("grows monotonically with prompt size", () => {
    expect(estimateCallTokens("x".repeat(8000))).toBeGreaterThan(estimateCallTokens("x".repeat(4000)));
  });
});

describe("rateLimitBackoffMs", () => {
  it("honours a 429 'wait N seconds' hint (+margin)", () => {
    const e = new Error('0G Compute inference failed: 429 {"message":"Token rate limit exceeded. Please wait 13 seconds (limit: 2000 tokens/min)."}');
    expect(rateLimitBackoffMs(e)).toBe(13 * 1000 + 1500);
  });

  it("defaults to a window-ish pause for a 429 with no explicit seconds", () => {
    expect(rateLimitBackoffMs(new Error("429 rate limit error"))).toBe(12 * 1000 + 1500);
  });

  it("caps the backoff so a bogus huge hint cannot stall forever", () => {
    expect(rateLimitBackoffMs(new Error("429 please wait 9999 seconds"))).toBe(65_000);
  });

  it("returns undefined for non-rate-limit errors (keeps their normal backoff)", () => {
    expect(rateLimitBackoffMs(new Error("ETIMEDOUT socket hang up"))).toBeUndefined();
    expect(rateLimitBackoffMs({ code: "TIMEOUT" })).toBeUndefined();
  });
});
