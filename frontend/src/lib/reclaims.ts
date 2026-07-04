/**
 * Shared "what can this wallet reclaim on a battle?" derivation. Given the viewer's positions across a
 * match's markets (from readPropPositions) plus the match's terminal state, it returns the outstanding
 * pots — a SETTLED win pays pro-rata, a Void returns the stake, a REFUND match returns the stake in full.
 * Both the History screen and the live winnings tray consume this so "you won X" is computed one way.
 */
import type { MatchSummary, PropPosition } from "./contract.js";

export type ReclaimKind = "win" | "return" | "refund" | "enable";

/** A reclaimable pot the viewer holds on a battle — the FACTION headline or any side market. */
export interface PropReclaim {
  index: number;
  /** FACTION / MAFIA_SEAT: unused. PLAYER_FATE: the seat. ROUND_VOTED_OUT / NIGHT_KILL: the 1-based round. DETECTIVE_CLAIM: the claiming seat. (for the label) */
  param: number;
  /** Which market this pot is — drives the label ("faction verdict" / "seat N · fate" / "round R vote" / "night R kill" / "seat N · claim" / "who is the mafia?"). */
  market: "FACTION" | "PLAYER_FATE" | "ROUND_VOTED_OUT" | "NIGHT_KILL" | "DETECTIVE_CLAIM" | "MAFIA_SEAT";
  /** markets never need `enable` — they settle/refund with the parent match. */
  kind: "win" | "return" | "refund";
  amount: string;
}

/**
 * Outstanding pots for the viewer on a terminal match, across EVERY market (the FACTION headline + the
 * side markets). A SETTLED prop pays the winning outcome's backers pro-rata, returns the stake on Void,
 * and a REFUND match returns the stake in full. Already-claimed or losing positions are omitted; the
 * faction reclaim is surfaced first so it leads any list.
 */
export function propReclaimsOf(positions: PropPosition[], state: MatchSummary["state"]): PropReclaim[] {
  const out: PropReclaim[] = [];
  for (const p of positions) {
    if (p.claimed) continue;
    const total = p.stakes.reduce((s, v) => s + parseFloat(v), 0);
    if (total <= 0) continue;

    if (state === "REFUND") {
      out.push({ index: p.index, param: p.param, market: p.kind, kind: "refund", amount: total.toFixed(4) });
      continue;
    }
    // SETTLED
    if (p.state === "RESOLVED") {
      const win = p.winningOutcome != null ? parseFloat(p.stakes[p.winningOutcome] ?? "0") : 0;
      if (win <= 0) continue; // backed a losing outcome — nothing to collect
      const wp = parseFloat(p.winningPool);
      const np = parseFloat(p.netPot);
      out.push({ index: p.index, param: p.param, market: p.kind, kind: "win", amount: (wp > 0 ? (np * win) / wp : 0).toFixed(4) });
    } else if (p.state === "VOID") {
      out.push({ index: p.index, param: p.param, market: p.kind, kind: "return", amount: total.toFixed(4) });
    }
  }
  // Lead with the headline faction reclaim, then the side markets in prop order.
  return out.sort((a, b) => (a.market === "FACTION" ? -1 : 0) - (b.market === "FACTION" ? -1 : 0));
}
