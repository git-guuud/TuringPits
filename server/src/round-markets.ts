/**
 * Timing predicates for the two RECURRING per-round side markets — "voted out" (the day vote) and
 * "night kill" (before dawn). They answer ONE question each: has round R's outcome become PUBLIC yet,
 * given the live game state? The orchestrator uses them to decide when to freeze each market on-chain
 * (closeProp) so nobody can bet an already-decided market. Pure, so the timing invariant is unit-testable
 * independently of the RPC plumbing in orchestrator.ts.
 *
 * A round runs NIGHT then DAY: night R resolves at dawn (phase flips to "day", round still R), and the
 * day R vote resolves when the round advances (round becomes R+1). So:
 *   - the night kill of round R is public once we've reached day R (or any later round / game over);
 *   - the day vote of round R is public once the match has moved PAST round R (or the game is over).
 * `winner != null` (game over) makes every opened round's outcome final.
 */
export interface RoundPhase {
  /** 1-based current round. */
  round: number;
  /** Current phase — night R precedes day R. */
  phase: "night" | "day";
  /** Non-null once the moderator has declared a winner (the match is over). */
  winner: unknown;
}

/** True once round `r`'s NIGHT kill is public (dawn has broken on it) — the cue to freeze its market. */
export function nightKillResolved(state: RoundPhase, r: number): boolean {
  if (state.winner != null) return true;
  if (r < state.round) return true; // we're in a later round → night r long done
  return r === state.round && state.phase === "day"; // dawn of round r: night r just resolved
}

/** True once round `r`'s DAY vote is public (the match has moved past it) — the cue to freeze its market. */
export function votedOutResolved(state: RoundPhase, r: number): boolean {
  if (state.winner != null) return true;
  return r < state.round; // the vote resolves as the round advances (day r stays live within round r)
}
