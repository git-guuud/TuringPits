/**
 * "One Detective claim per match" staging rule — pure so the invariant is unit-testable without a chain.
 *
 * A discussion turn that reads as a public Detective claim (a real reveal or a Mafia fake-claim) is only
 * a NEW public event the FIRST time a given seat makes it. The single "Detective claim: real or bluff?"
 * market opens once and stays open until settle (roles are hidden mid-match), so:
 *   - the first claimant floats the market AND fires its betting spotlight (a `bet_window` pause), once;
 *   - a DIFFERENT seat going public afterwards is a genuine rival — a `counter` claim scene (a bettable
 *     fork on the SAME open pool) — but does NOT re-open the spotlight;
 *   - the SAME seat repeating its own standing claim in a later round is not a new event at all, so it
 *     streams as ordinary deliberation (no duplicate claim scene, no re-opened window).
 *
 * The last case is the bug this fixes: a Mafia that bluffed the Detective in two consecutive rounds used
 * to re-fire the window and "reopen" the market each round. Deduping by seat + a once-only window flag
 * enforces the intended one-claim-per-match behaviour.
 */
export interface ClaimDecision {
  /** Promote this turn to a first-class `claim` scene (a seat going public as the Detective). */
  claim: boolean;
  /** This claim rivals an earlier one (a different seat) — a bettable fork. Only meaningful when `claim`. */
  counter: boolean;
  /** Pause + spotlight the "real or bluff?" market now (at most once per match). Only when `claim`. */
  showWindow: boolean;
}

/**
 * Decide how a discussion turn that MAY be a public Detective claim should be staged.
 * @param claimedSeats seats that have ALREADY gone public as the Detective this match.
 * @param windowShown  whether the claim's betting spotlight has already fired this match.
 * @param seat         the speaking seat.
 * @param isClaim      whether this speech reads as a Detective claim (from `claimsDetective`).
 */
export function classifyDetectiveClaim(
  claimedSeats: ReadonlySet<number>,
  windowShown: boolean,
  seat: number,
  isClaim: boolean,
): ClaimDecision {
  // Only a seat's FIRST public claim is a fresh event; a repeat by an already-claimed seat is not.
  const fresh = isClaim && !claimedSeats.has(seat);
  return {
    claim: fresh,
    counter: fresh && claimedSeats.size > 0, // a rival claimant after the first is a fork
    showWindow: fresh && !windowShown,        // spotlight the market once, on the first claim
  };
}
