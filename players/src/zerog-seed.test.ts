import { describe, expect, it } from "vitest";
import { toProviderSeed } from "./zerog.js";

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
