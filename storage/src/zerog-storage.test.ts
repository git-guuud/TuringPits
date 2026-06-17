import { describe, expect, it } from "vitest";
import { root } from "./zerog-storage.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

// Exercises the real 0G Storage SDK merkle-tree computation — no network, no funds.
// This is the content-addressing the upload path announces and the verifier re-derives.
describe("root (0G Storage content identifier)", () => {
  it("computes a 0x-prefixed 32-byte merkle root", async () => {
    const r = await root(utf8("evidence"));
    expect(r).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic for identical bytes", async () => {
    expect(await root(utf8("same payload"))).toBe(await root(utf8("same payload")));
  });

  it("differs when the bytes differ", async () => {
    expect(await root(utf8("payload A"))).not.toBe(await root(utf8("payload B")));
  });
});
