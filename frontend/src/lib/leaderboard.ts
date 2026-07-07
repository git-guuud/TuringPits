/**
 * Match leaderboard — every bettor on a finished match, ranked by realized profit/loss.
 *
 * Bettors are enumerated from the chain (readMatchBettors → PropBetPlaced logs), and each one's P&L is
 * computed with the EXACT same maths the Battle-History screen uses for the viewer's own net
 * (propOutcomeOf: staked vs. what those positions return across every market). So "you netted +◈X" reads
 * identically whether you look at History or the leaderboard — one source of truth for the money.
 *
 * Names are joined in the UI (lib/names.ts + the server's shared handles), not here, so this stays a
 * pure chain-read + a pure ranking function (rankRows, unit-tested-friendly).
 */
import { MARKET_ADDRESS, readMatchBettors, readPropPositions } from "./contract.js";
import { propOutcomeOf } from "./reclaims.js";
import type { MarketState } from "./types.js";

/** One competitor on the board — an address and its realized result on this match. */
export interface LeaderRow {
  address: string;
  /** Total CHIP wagered across every market of the match. */
  staked: number;
  /** Gross CHIP those positions return (winning payouts + Void/refund returns). */
  returned: number;
  /** Net profit (returned − staked): positive is a win, negative a loss. */
  net: number;
}

/**
 * Rank by realized net P&L (desc), then by amount staked (desc — a bigger bettor leads on a tie), then
 * address (a stable final tiebreak). Pure: no I/O, so it's the easy thing to reason about / test.
 */
export function rankRows(rows: LeaderRow[]): LeaderRow[] {
  return [...rows].sort(
    (a, b) => b.net - a.net || b.staked - a.staked || a.address.toLowerCase().localeCompare(b.address.toLowerCase()),
  );
}

/**
 * Build the leaderboard for a terminal (SETTLED / REFUND) match: enumerate its bettors, compute each
 * one's net, drop anyone with no live stake, and rank. A single bettor's position-read failing degrades
 * gracefully (that row is dropped) rather than failing the whole board.
 */
export async function readMatchLeaderboard(
  matchId: number,
  state: Extract<MarketState, "SETTLED" | "REFUND">,
  address: string = MARKET_ADDRESS,
): Promise<LeaderRow[]> {
  const bettors = await readMatchBettors(matchId, address);
  const rows = await Promise.all(
    bettors.map(async (bettor): Promise<LeaderRow | null> => {
      try {
        const positions = await readPropPositions(address, matchId, bettor);
        const { staked, returned, net } = propOutcomeOf(positions, state);
        if (staked <= 0) return null; // no live stake (all already-refunded / dust) — leave off the board
        return { address: bettor, staked, returned, net };
      } catch {
        return null;
      }
    }),
  );
  return rankRows(rows.filter((r): r is LeaderRow => r !== null));
}
