export * from "./types.js";

import type { MatchInput, MatchOutput } from "./types.js";

/**
 * Run a full deterministic chess match.
 *
 * TODO(Day 1/2): implement the full chess engine. Determinism is the contract —
 * `playMatch` MUST return byte-identical output for identical input, with the seed
 * as the only randomness source. Plan: use a deterministic chess move generator
 * (own implementation or a vetted lib such as chess.js, pinned + checked for
 * determinism) and a seeded PRNG (e.g. a small xoshiro/mulberry32 keyed by `seed`).
 *
 * This stub throws so nothing silently depends on a fake result.
 */
export function playMatch(_input: MatchInput): MatchOutput {
  throw new Error("playMatch not implemented yet — see TODO.md Day 1/2");
}
