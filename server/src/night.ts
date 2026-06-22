/**
 * Night redaction gate — the single chokepoint that guarantees no role can leak from the live
 * stream. A raw match emits one attested turn per night actor (the Mafia's kill, the Doctor's
 * save, the Detective's investigation), each naming the seat + its action + its speech. Streaming
 * those would tell every spectator who holds which role mid-match, defeating the betting market.
 *
 * `gateTurn` converts each attested turn into the messages that are SAFE to broadcast:
 *   - night actor turns  → never produce a `turn`; at most a single `night` beat per round, and a
 *                          `dawn` beat (carrying ONLY the publicly-known death) once night resolves.
 *   - day votes          → pass through as `turn` (voting is public and attributable).
 *
 * It is pure over the wire types (no engine state, no `RecordedTurn`) so the invariant is unit-
 * testable. Settlement is unaffected — it uses the full `result.turns`, not the broadcast.
 */
import type { PublicGameState, PublicTurn, WsMessage } from "./wire.js";

export interface NightGate {
  prevAlive: Set<number>;
  announcedNightRound: number;
}

export function newNightGate(seatIds: number[]): NightGate {
  return { prevAlive: new Set(seatIds), announcedNightRound: -1 };
}

const aliveOf = (pub: PublicGameState): Set<number> =>
  new Set(pub.players.filter((p) => p.alive).map((p) => p.id));

/**
 * @param decisionPhase phase the turn's decision was made in ("night" | "day")
 * @param decisionRound  round the decision was made in
 * @param pub            the REDACTED public state AFTER the turn applied (the final night action
 *                       flips `pub.phase` to "day" with the kill resolved)
 * @param dayTurn        the redacted public turn — only ever broadcast for a day vote
 * @returns the messages safe to broadcast for this turn (mutates `gate`)
 */
export function gateTurn(
  gate: NightGate,
  decisionPhase: "night" | "day",
  decisionRound: number,
  pub: PublicGameState,
  dayTurn: PublicTurn,
): WsMessage[] {
  const out: WsMessage[] = [];

  if (decisionPhase === "night") {
    if (gate.announcedNightRound !== decisionRound) {
      gate.announcedNightRound = decisionRound;
      out.push({ type: "night", round: decisionRound });
    }
    // The final night action resolves the phase: pub.phase flips to "day" with the kill applied.
    if (pub.phase === "day") {
      const aliveNow = aliveOf(pub);
      const killed = [...gate.prevAlive].filter((id) => !aliveNow.has(id));
      gate.prevAlive = aliveNow;
      out.push({ type: "dawn", round: decisionRound, killed, state: pub });
    }
    return out; // a night actor turn is NEVER broadcast
  }

  // Day vote — public and attributable.
  gate.prevAlive = aliveOf(pub);
  out.push({ type: "turn", turn: dayTurn, state: pub });
  return out;
}
