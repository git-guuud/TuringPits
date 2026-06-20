/**
 * Role redaction — the single most important server adapter. The engine `GameState` carries a
 * hidden `role` for every seat; streaming it raw would leak the Mafia. These projections strip
 * roles (and internal pending/investigations) so the browser only ever sees what the public
 * sees during play. Roles are revealed only at the end, via the `reveal` message.
 */
import type { GameState, Role } from "@turingpits/engine";
import type { RecordedTurn } from "@turingpits/players";
import type { PublicGameState, PublicTurn } from "./wire.js";

const ACTION_NAME: Record<number, string> = { 0: "kill", 1: "save", 2: "investigate", 3: "vote" };

export function toPublicState(state: GameState): PublicGameState {
  return {
    nonce: state.nonce,
    phase: state.phase,
    round: state.round,
    players: state.players.map((p) => ({ id: p.id, alive: p.alive })), // role intentionally dropped
    winner: state.winner,
  };
}

export function toPublicTurn(turn: RecordedTurn): PublicTurn {
  const d = turn.structuredDecision;
  return {
    seat: turn.seat,
    speech: turn.speech,
    decision: {
      phase: d.phase,
      round: d.round,
      player: d.player,
      action: typeof d.action === "string" ? d.action : (ACTION_NAME[d.action as unknown as number] ?? String(d.action)),
      target: d.target,
    },
    attestation: { source: turn.attestation.source, signerAddress: turn.attestation.signerAddress },
  };
}

export const ROLE_NAMES: readonly Role[] = ["MAFIA", "DOCTOR", "DETECTIVE", "TOWN"];
