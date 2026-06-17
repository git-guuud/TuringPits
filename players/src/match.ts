import { initState, applyDecision, winner as winnerOf } from "@turingpits/engine";
import type { Action, Faction, GameState, Role } from "@turingpits/engine";
import type { Player } from "./player.js";
import type { Persona, PlayerTurn, TurnContext } from "./types.js";

export interface MatchConfig {
  readonly seed: string;
  readonly n: number;
  readonly nonce: string;
  readonly personas: readonly Persona[];
  /** One `Player` per seat (BYOM-ready). Seats may share one provider (one TEE key). */
  readonly players: readonly Player[];
  /** Safety cap so a pathological game can never loop forever. Default 50. */
  readonly maxRounds?: number;
}

/** A recorded turn: the seat, its speech, structured decision, and TEE attestation. */
export interface RecordedTurn extends PlayerTurn {
  readonly seat: number;
}

export interface AttestedMatch {
  readonly winner: Faction | null;
  readonly turns: readonly RecordedTurn[];
  readonly finalState: GameState;
}

/** The night action each role performs (day is always `vote`). */
const NIGHT_ACTION: Partial<Record<Role, Action>> = {
  MAFIA: "kill",
  DOCTOR: "save",
  DETECTIVE: "investigate",
};

/**
 * The seats that must act this phase, in seat order, with their action and legal targets.
 * Orchestration logic (the Sequencer's job) — the moderator still validates every decision
 * and throws on anything illegal, so this never overrides the rules.
 */
function phaseActors(state: GameState): { seat: number; action: Action; legalTargets: number[] }[] {
  const living = state.players.filter((p) => p.alive).map((p) => p.id);
  const out: { seat: number; action: Action; legalTargets: number[] }[] = [];

  for (const p of state.players) {
    if (!p.alive) continue;
    if (state.phase === "day") {
      out.push({ seat: p.id, action: "vote", legalTargets: living.filter((id) => id !== p.id) });
    } else {
      const action = NIGHT_ACTION[p.role];
      if (!action) continue;
      // Doctor may protect anyone including itself; kill/investigate exclude self.
      const targets = action === "save" ? living : living.filter((id) => id !== p.id);
      out.push({ seat: p.id, action, legalTargets: targets });
    }
  }
  return out;
}

/**
 * Drive a full Mafia match: the deterministic Day-1 moderator sequences phases, each acting
 * seat's `Player` produces a TEE-attested decision, and the moderator advances state. The
 * public speech log feeds back into each player's prompt for the spectacle. Returns the
 * ordered attested turns and the declared winner.
 *
 * This is the headless integration driver; the WebSocket-streaming Sequencer (Day 6) wraps
 * this same loop.
 */
export async function playMatch(config: MatchConfig): Promise<AttestedMatch> {
  const { seed, n, nonce, personas, players, maxRounds = 50 } = config;
  if (players.length !== n) throw new Error(`expected ${n} players, got ${players.length}`);
  if (personas.length !== n) throw new Error(`expected ${n} personas, got ${personas.length}`);

  let state = initState(seed, n, nonce);
  const turns: RecordedTurn[] = [];
  const transcript: [number, string][] = [];

  while (winnerOf(state) === null) {
    if (state.round > maxRounds) throw new Error(`match exceeded ${maxRounds} rounds without a winner`);

    const actors = phaseActors(state);
    for (const { seat, action, legalTargets } of actors) {
      const role = state.players[seat]!.role;
      const ctx: TurnContext = {
        persona: personas[seat]!,
        role,
        alive: state.players.filter((p) => p.alive).map((p) => p.id),
        transcript: transcript.map(([s, t]) => [s, t] as const),
        decisionStub: { nonce, phase: state.phase, round: state.round, player: seat, action },
        legalTargets,
      };

      const turn = await players[seat]!.takeTurn(ctx);
      state = applyDecision(state, turn.structuredDecision);
      turns.push({ seat, ...turn });
      transcript.push([seat, turn.speech]);

      if (winnerOf(state) !== null) break; // game ended mid-phase resolution
    }
  }

  return { winner: winnerOf(state), turns, finalState: state };
}
