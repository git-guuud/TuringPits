import { Buffer } from "node:buffer";
import { getBytes } from "ethers";
import { encodeDecision, initState, applyDecision, winner as winnerOf } from "@turingpits/engine";
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
  /**
   * Optional per-turn hook fired right after each attested turn is applied — for incremental
   * logging and the Day-6 WebSocket sequencer. Receives the recorded turn and the resulting
   * game state. Awaited, so a slow consumer paces the match.
   */
  readonly onTurn?: (turn: RecordedTurn, state: GameState) => void | Promise<void>;
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

/** Solidity `Phase`/`Action` enum encodings (must match `contracts/contracts/MafiaTypes.sol`). */
const PHASE_ENUM = { night: 0, day: 1 } as const;
const ACTION_ENUM = { kill: 0, save: 1, investigate: 2, vote: 3 } as const;

/** The typed `Decision` tuple `MafiaMarket.settle()` consumes (enums, no `nonce` — nonce is market-level). */
export interface SolDecision {
  readonly phase: number;
  readonly round: number;
  readonly player: number;
  readonly action: number;
  readonly target: number;
}

/** One `Move` of `MafiaMarket.settle()` calldata: a typed decision + its TEE envelope. */
export interface SettlementMove {
  readonly decision: SolDecision;
  readonly rawResponseBody: string;
  readonly contentOffset: number;
  readonly contentLen: number;
  readonly reqHashHex: string;
  readonly signature: string;
}

/**
 * Map one attested decision turn to `MafiaMarket.settle()` calldata. The contract binds the
 * typed decision to the signed body by slicing `rawResponseBody[offset:offset+len]` and
 * comparing it to its on-chain re-encoding of the decision; `parseDecision` already guaranteed
 * the model output is byte-identical to `encodeDecision`, so we assert that binding here to
 * fail fast on any drift before paying gas.
 */
export function toSettlementMove(turn: PlayerTurn): SettlementMove {
  const d = turn.structuredDecision;
  const att = turn.attestation;

  const embedded = JSON.stringify(encodeDecision(d)).slice(1, -1); // JSON-escaped, as it sits in the body
  const bodyBytes = getBytes(att.rawResponseBody);
  const slice = Buffer.from(bodyBytes.slice(att.contentOffset, att.contentOffset + att.contentLen)).toString("utf8");
  if (slice !== embedded) {
    throw new Error("attestation does not bind the decision to its signed body (offset/len mismatch)");
  }

  return {
    decision: {
      phase: PHASE_ENUM[d.phase],
      round: d.round,
      player: d.player,
      action: ACTION_ENUM[d.action],
      target: d.target,
    },
    rawResponseBody: att.rawResponseBody,
    contentOffset: att.contentOffset,
    contentLen: att.contentLen,
    reqHashHex: att.reqHashHex,
    signature: att.signature,
  };
}

/**
 * The private knowledge a seat's role legitimately grants this turn, derived from the full
 * moderator `state` (hidden roles, detective findings) and the recorded `turns` (its own past
 * moves). Mafia learn their teammates, the detective recalls its investigation results, and
 * every seat recalls its own prior actions. Town members with no special power get nothing.
 */
export function privateKnowledge(
  state: GameState,
  turns: readonly RecordedTurn[],
  seat: number,
  role: Role,
): Pick<TurnContext, "teammates" | "investigations" | "ownHistory"> {
  const out: {
    teammates?: number[];
    investigations?: { round: number; target: number; faction: string }[];
    ownHistory?: { round: number; phase: string; action: string; target: number }[];
  } = {};

  if (role === "MAFIA") {
    out.teammates = state.players.filter((p) => p.role === "MAFIA" && p.id !== seat).map((p) => p.id);
  }
  if (role === "DETECTIVE") {
    out.investigations = state.investigations
      .filter((i) => i.detective === seat)
      .map((i) => ({ round: i.round, target: i.target, faction: i.faction }));
  }
  const own = turns.filter((t) => t.seat === seat).map((t) => {
    const d = t.structuredDecision;
    return { round: d.round, phase: d.phase, action: d.action, target: d.target };
  });
  if (own.length > 0) out.ownHistory = own;

  return out;
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

  const { onTurn } = config;
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
        ...privateKnowledge(state, turns, seat, role),
      };

      const turn = await players[seat]!.takeTurn(ctx);
      state = applyDecision(state, turn.structuredDecision);
      const recorded: RecordedTurn = { seat, ...turn };
      turns.push(recorded);
      transcript.push([seat, turn.speech]);
      if (onTurn) await onTurn(recorded, state);

      if (winnerOf(state) !== null) break; // game ended mid-phase resolution
    }
  }

  return { winner: winnerOf(state), turns, finalState: state };
}
