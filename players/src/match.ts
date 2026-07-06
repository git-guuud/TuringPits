import { Buffer } from "node:buffer";
import { getBytes } from "ethers";
import { encodeDecision, initState, applyDecision, winner as winnerOf } from "@turingpits/engine";
import type { Action, Faction, GameState, Role } from "@turingpits/engine";
import { claimsDetective } from "./sanitize.js";
import type { Player } from "./player.js";
import type { DeathEvent, Persona, PlayerTurn, TurnContext } from "./types.js";

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
  /**
   * Optional hook fired for each unsigned discussion contribution in the day's discussion pass
   * (before any vote). Discussion is public speech but never signed and never settles. Awaited.
   */
  readonly onDiscussion?: (entry: DiscussionEntry, state: GameState) => void | Promise<void>;
  /**
   * Optional hook fired ONCE at the start of each night phase, BEFORE any night actor acts — the cue
   * to open the "who dies tonight?" betting window while the kill is still hidden. Awaited, so a
   * consumer can pause the loop for the window's duration (the market stream is deliberately blocked
   * on this, so the pause is real). Receives the 1-based round and the current (pre-night) state.
   */
  readonly onNightfall?: (round: number, state: GameState) => void | Promise<void>;
  /**
   * Optional hook fired ONCE per day, AFTER the discussion pass and BEFORE the vote pass — the cue to
   * open the "who hangs this round?" betting window before any vote is cast (so the outcome can't leak
   * from an in-progress tally). Awaited (pauses the loop). Receives the 1-based round and the state.
   */
  readonly onPreVote?: (round: number, state: GameState) => void | Promise<void>;
}

/** A recorded turn: the seat, its speech, structured decision, and TEE attestation. */
export interface RecordedTurn extends PlayerTurn {
  readonly seat: number;
}

/** One unsigned public discussion contribution during a day's discussion pass. */
export interface DiscussionEntry {
  readonly seat: number;
  readonly round: number;
  readonly speech: string;
  /**
   * True when this speech is the seat going PUBLIC as the Detective — a genuine reveal or a Mafia's
   * fake claim (detected by {@link claimsDetective} on the cleaned speech). The Sequencer promotes such
   * a beat to a first-class `claim` stage scene and floats the "Detective claim: real or bluff?" market
   * on the FIRST one. It carries NO role information — whether the claim is TRUE settles only from the
   * revealed roles — so streaming it leaks nothing.
   */
  readonly claim: boolean;
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
export function phaseActors(state: GameState): { seat: number; action: Action; legalTargets: number[] }[] {
  const living = state.players.filter((p) => p.alive).map((p) => p.id);
  const mafiaIds = new Set(state.players.filter((p) => p.role === "MAFIA").map((p) => p.id));
  const out: { seat: number; action: Action; legalTargets: number[] }[] = [];

  for (const p of state.players) {
    if (!p.alive) continue;
    if (state.phase === "day") {
      // A voter never targets itself; a Mafia also never targets a teammate. Day votes are legally
      // free to hit anyone, but the weak model confuses its own team and self-eliminates, so we
      // never OFFER a Mafia a teammate (incl. on the deterministic fallback). The vote stays a
      // legal subset, so settlement is unaffected.
      const targets = living.filter((id) => id !== p.id && !(p.role === "MAFIA" && mafiaIds.has(id)));
      out.push({ seat: p.id, action: "vote", legalTargets: targets });
    } else {
      const action = NIGHT_ACTION[p.role];
      if (!action) continue;
      // Doctor may protect anyone including itself; the detective investigates anyone but itself;
      // the Mafia may never target a teammate (so even the deterministic fallback can't team-kill).
      const targets =
        action === "save" ? living
        : action === "kill" ? living.filter((id) => !mafiaIds.has(id))
        : living.filter((id) => id !== p.id);
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

  const { onTurn, onDiscussion, onNightfall, onPreVote } = config;
  let state = initState(seed, n, nonce);
  const turns: RecordedTurn[] = [];
  const transcript: [number, string][] = [];
  // Public death log: who died, when, and how. Derived by diffing the alive set as the
  // moderator resolves each phase — it carries no hidden info (the table always sees deaths).
  const deaths: DeathEvent[] = [];

  const livingSeats = (s: GameState): number[] => s.players.filter((p) => p.alive).map((p) => p.id);

  // Build the context a seat needs this turn (private knowledge derived from full state + turns).
  const ctxFor = (
    seat: number,
    action: Action,
    legalTargets: number[],
    stage: "night" | "discussion" | "vote",
  ): TurnContext => ({
    persona: personas[seat]!,
    role: state.players[seat]!.role,
    alive: livingSeats(state),
    roster: personas,
    transcript: transcript.map(([s, t]) => [s, t] as const),
    decisionStub: { nonce, phase: state.phase, round: state.round, player: seat, action },
    legalTargets,
    stage,
    deaths: deaths.map((d) => ({ ...d })),
    ...privateKnowledge(state, turns, seat, state.players[seat]!.role),
  });

  // Apply an ALREADY-COMPUTED turn: record it, advance state, stream it. Split from the inference so the
  // model call for a turn can run CONCURRENTLY with a betting window — the window hook holds the loop for
  // its countdown, and the call for what happens once it closes overlaps that hold instead of starting
  // fresh afterwards (which is what left dead air between the market closing and the next beat).
  const applyTurn = async (seat: number, turn: PlayerTurn): Promise<boolean> => {
    const aliveBefore = new Set(livingSeats(state));
    state = applyDecision(state, turn.structuredDecision);
    // Any seat that flipped alive→dead when this turn resolved the phase is now a public death,
    // attributed to the phase/round the action was taken in (night kill vs day vote).
    const { phase, round } = turn.structuredDecision;
    for (const p of state.players) {
      if (!p.alive && aliveBefore.has(p.id)) deaths.push({ round, phase, seat: p.id });
    }
    const recorded: RecordedTurn = { seat, ...turn };
    turns.push(recorded);
    // Day vote justifications are public; night reasoning is never broadcast.
    if (turn.structuredDecision.phase === "day") transcript.push([seat, turn.speech]);
    if (onTurn) await onTurn(recorded, state);
    return winnerOf(state) !== null;
  };

  // Kick off a seat's inference NOW but defer surfacing the result until the loop awaits it — so a turn
  // precomputed to overlap a betting window neither blocks the window nor raises an unhandled rejection
  // while the window holds (any failure is re-thrown when the getter is finally awaited, in order).
  const startTurn = (seat: number, action: Action, legalTargets: number[], stage: "night" | "vote") => {
    const settled = players[seat]!
      .takeTurn(ctxFor(seat, action, legalTargets, stage))
      .then((turn) => ({ turn }), (err: unknown) => ({ err }));
    return async (): Promise<PlayerTurn> => {
      const r = await settled;
      if ("err" in r) throw r.err;
      return r.turn;
    };
  };

  while (winnerOf(state) === null) {
    if (state.round > maxRounds) throw new Error(`match exceeded ${maxRounds} rounds without a winner`);

    if (state.phase === "night") {
      // Night actions are simultaneous and independent — every actor decides from the same pre-night
      // state, blind to the others — so start ALL of them now and let the model calls run while the
      // "who dies tonight?" window holds the loop. By the time it closes the decisions are in hand, so
      // dawn follows immediately instead of after a fresh round of inference. (Any actor whose turn we
      // never apply — a kill that ends the match first — is harmlessly settled and dropped.)
      const actors = phaseActors(state);
      const pending = actors.map((a) => startTurn(a.seat, a.action, a.legalTargets, "night"));
      if (onNightfall) await onNightfall(state.round, state);
      for (let i = 0; i < actors.length; i++) {
        if (await applyTurn(actors[i]!.seat, await pending[i]!())) break;
      }
    } else {
      // DAY — discussion pass (unsigned, streamed), then vote pass (signed).
      const living = livingSeats(state);
      for (const seat of living) {
        const targets = living.filter((id) => id !== seat);
        // Discussion carries the upcoming vote's action so the reason call anticipates the
        // vote target; there is no discussion-only action (no DECISION_RULE for one).
        const { speech } = await players[seat]!.discuss(ctxFor(seat, "vote", targets, "discussion"));
        transcript.push([seat, speech]);
        // Tag a Detective reveal / Mafia fake-claim so the Sequencer can promote it to a claim beat and
        // float the reveal market. Detected off the CLEANED speech (post-guard), carries no role info.
        const claim = claimsDetective(speech);
        if (onDiscussion) await onDiscussion({ seat, round: state.round, speech, claim }, state);
      }
      // Start the FIRST voter's inference now so it overlaps the "who hangs this round?" window and the
      // tally opens the instant the window closes. Only the first is safe to precompute: every LATER voter
      // reacts to the votes cast before it (the bandwagon), so its inference legitimately waits on the
      // vote ahead — it stays sequential.
      const firstSeat = living[0];
      const firstVote =
        firstSeat != null ? startTurn(firstSeat, "vote", living.filter((id) => id !== firstSeat), "vote") : null;
      // The floor has spoken — open the "who hangs this round?" window before the first vote is cast.
      if (onPreVote) await onPreVote(state.round, state);
      for (let i = 0; i < living.length; i++) {
        const seat = living[i]!;
        const targets = living.filter((id) => id !== seat);
        const turn = i === 0 && firstVote ? await firstVote() : await players[seat]!.takeTurn(ctxFor(seat, "vote", targets, "vote"));
        if (await applyTurn(seat, turn)) break;
      }
    }
  }

  return { winner: winnerOf(state), turns, finalState: state };
}
