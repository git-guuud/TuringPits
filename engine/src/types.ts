/** Shared types for the deterministic match engine. */

/** A single agent: a pure, deterministic chess move-selection policy. */
export interface Agent {
  /** Stable identifier, used in PGN headers and storage. */
  readonly id: string;
  /**
   * Select a move given the current position and a deterministic PRNG.
   * MUST be pure: no clock, no I/O, no global RNG. All randomness comes from `rng`.
   *
   * @param fen     Current position in Forsyth–Edwards Notation.
   * @param legal   Legal moves in this position (SAN), provided by the engine.
   * @param rng     Seeded PRNG; the only allowed source of randomness.
   * @returns the chosen move in SAN, which MUST be one of `legal`.
   */
  selectMove(fen: string, legal: readonly string[], rng: () => number): string;
}

export type MatchResult = "1-0" | "0-1" | "1/2-1/2";

export interface MatchOutput {
  /** Canonical PGN of the full game (the battle log). */
  pgn: string;
  /** Final result. */
  result: MatchResult;
  /** Moves in SAN, in order. */
  moves: readonly string[];
}

export interface MatchInput {
  /** 32-byte hex seed (the revealed secret). Drives the PRNG only. */
  seed: string;
  white: Agent;
  black: Agent;
}
