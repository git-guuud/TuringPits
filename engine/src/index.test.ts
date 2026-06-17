import { describe, it, expect } from "vitest";
import { playMatch } from "./index.js";

// Day 1 exit criterion: same input → byte-identical output.
// Skipped until playMatch is implemented; flip `.skip` off in the Day 1 session.
describe.skip("playMatch determinism", () => {
  it("produces identical PGN for identical (seed, agents)", () => {
    const input = {
      seed: "0x" + "11".repeat(32),
      white: {
        id: "random-w",
        selectMove: (_f: string, legal: readonly string[], rng: () => number) =>
          legal[Math.floor(rng() * legal.length)]!,
      },
      black: {
        id: "random-b",
        selectMove: (_f: string, legal: readonly string[], rng: () => number) =>
          legal[Math.floor(rng() * legal.length)]!,
      },
    };
    const a = playMatch(input);
    const b = playMatch(input);
    expect(a.pgn).toEqual(b.pgn);
    expect(a.result).toEqual(b.result);
  });
});
