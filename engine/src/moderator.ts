import { createHash } from "node:crypto";
import type {
  Action,
  Decision,
  Faction,
  GameState,
  Investigation,
  PendingAction,
  PlayerState,
  Role,
} from "./types.js";

/**
 * Role composition per player count. MVP supports 5–8 seats.
 * Mirrored by the Solidity state machine on Day 5.
 */
const COMPOSITION: Record<number, Role[]> = {
  5: ["MAFIA", "DOCTOR", "DETECTIVE", "TOWN", "TOWN"],
  6: ["MAFIA", "DOCTOR", "DETECTIVE", "TOWN", "TOWN", "TOWN"],
  7: ["MAFIA", "MAFIA", "DOCTOR", "DETECTIVE", "TOWN", "TOWN", "TOWN"],
  8: ["MAFIA", "MAFIA", "DOCTOR", "DETECTIVE", "TOWN", "TOWN", "TOWN", "TOWN"],
};

/**
 * Deterministic PRNG: a counter-based SHA-256 stream keyed by `seed`.
 * Each call returns a float in [0, 1). Pure — hashing is deterministic, not I/O.
 */
function makeRng(seed: string): () => number {
  const key = Buffer.from(seed.replace(/^0x/, ""), "hex");
  let counter = 0;
  return () => {
    const ctr = Buffer.alloc(4);
    ctr.writeUInt32BE(counter++, 0);
    const digest = createHash("sha256").update(key).update(ctr).digest();
    // Top 32 bits → [0, 1).
    return digest.readUInt32BE(0) / 0x1_0000_0000;
  };
}

/**
 * Assign roles to seats `0..n-1` deterministically from `seed`.
 * Builds the fixed composition for `n`, then Fisher–Yates shuffles with the seeded PRNG.
 */
export function assignRoles(seed: string, n: number): Role[] {
  const base = COMPOSITION[n];
  if (!base) {
    throw new Error(`unsupported player count ${n} (MVP supports 5–8)`);
  }
  const roles = [...base];
  const rng = makeRng(seed);
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [roles[i], roles[j]] = [roles[j]!, roles[i]!];
  }
  return roles;
}

const factionOf = (role: Role): Faction => (role === "MAFIA" ? "MAFIA" : "TOWN");

/** Which living seats must act this phase before it can resolve. */
function expectedActors(state: GameState): Set<number> {
  const ids = new Set<number>();
  for (const p of state.players) {
    if (!p.alive) continue;
    if (state.phase === "day") ids.add(p.id);
    else if (p.role === "MAFIA" || p.role === "DOCTOR" || p.role === "DETECTIVE") ids.add(p.id);
  }
  return ids;
}

/** Roles permitted to issue each action (the night roles; `vote` is day-only, any seat). */
const NIGHT_ACTION_ROLE: Record<"kill" | "save" | "investigate", Role> = {
  kill: "MAFIA",
  save: "DOCTOR",
  investigate: "DETECTIVE",
};

function assertLegal(state: GameState, d: Decision): void {
  if (state.winner !== null) throw new Error("game over: no further decisions accepted");
  if (d.nonce !== state.nonce) throw new Error(`nonce mismatch: expected ${state.nonce}`);
  if (d.phase !== state.phase || d.round !== state.round) {
    throw new Error(`out-of-order decision: expected ${state.phase} round ${state.round}`);
  }
  const n = state.players.length;
  if (!Number.isInteger(d.player) || d.player < 0 || d.player >= n) {
    throw new Error(`player index out of range: ${d.player}`);
  }
  if (!Number.isInteger(d.target) || d.target < 0 || d.target >= n) {
    throw new Error(`target index out of range: ${d.target}`);
  }
  const actor = state.players[d.player]!;
  const target = state.players[d.target]!;
  if (!actor.alive) throw new Error(`dead player ${d.player} cannot act`);
  if (!target.alive) throw new Error(`target ${d.target} is not alive`);

  const validForPhase: Action[] = state.phase === "day" ? ["vote"] : ["kill", "save", "investigate"];
  if (!validForPhase.includes(d.action)) {
    throw new Error(`action ${d.action} not valid during ${state.phase}`);
  }
  if (state.phase === "night") {
    const requiredRole = NIGHT_ACTION_ROLE[d.action as "kill" | "save" | "investigate"];
    if (actor.role !== requiredRole) {
      throw new Error(`role ${actor.role} cannot ${d.action} (requires ${requiredRole})`);
    }
  }
  if (state.pending.some((a) => a.player === d.player)) {
    throw new Error(`player ${d.player} already acted this phase`);
  }
}

/** Plurality winner of a target list; `null` on an empty list or a tie. */
function plurality(targets: readonly number[]): number | null {
  const counts = new Map<number, number>();
  for (const t of targets) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  let tied = false;
  for (const [target, count] of counts) {
    if (count > bestCount) {
      best = target;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  return tied ? null : best;
}

const computeWinner = (players: readonly PlayerState[]): Faction | null => {
  const aliveMafia = players.filter((p) => p.alive && p.role === "MAFIA").length;
  const aliveTown = players.filter((p) => p.alive && p.role !== "MAFIA").length;
  if (aliveMafia === 0) return "TOWN";
  if (aliveMafia >= aliveTown) return "MAFIA";
  return null;
};

const kill = (players: readonly PlayerState[], id: number): PlayerState[] =>
  players.map((p) => (p.id === id ? { ...p, alive: false } : p));

/** Resolve the accumulated night actions and advance to the day phase. */
function resolveNight(state: GameState, pending: readonly PendingAction[]): GameState {
  const killTarget = plurality(pending.filter((a) => a.action === "kill").map((a) => a.target));
  const saveTarget = pending.find((a) => a.action === "save")?.target ?? null;

  const investigations: Investigation[] = pending
    .filter((a) => a.action === "investigate")
    .map((a) => ({
      round: state.round,
      detective: a.player,
      target: a.target,
      faction: factionOf(state.players[a.target]!.role),
    }));

  // A kill lands unless the same seat was protected this night; a shielded target survives.
  const shielded = killTarget !== null && killTarget === saveTarget;
  const died = killTarget !== null && !shielded;
  let players = state.players;
  if (died) players = kill(players, killTarget);

  return {
    ...state,
    players,
    phase: "day",
    pending: [],
    investigations: [...state.investigations, ...investigations],
    // Public-safe night summary. `saved` records the shielded seat so the server can narrate a
    // blocked kill (from its count) without leaking the Doctor — see NightOutcome / night.ts.
    lastNight: {
      round: state.round,
      killed: died ? [killTarget as number] : [],
      saved: shielded ? [killTarget as number] : [],
    },
    winner: computeWinner(players),
  };
}

/** Resolve the accumulated day votes and advance to the next night. */
function resolveDay(state: GameState, pending: readonly PendingAction[]): GameState {
  const eliminated = plurality(pending.map((a) => a.target));
  const players = eliminated !== null ? kill(state.players, eliminated) : state.players;
  return {
    ...state,
    players,
    phase: "night",
    round: state.round + 1,
    pending: [],
    winner: computeWinner(players),
  };
}

/** Build the initial night-1 state: roles assigned from the seed, every seat alive. */
export function initState(seed: string, n: number, nonce: string): GameState {
  const roles = assignRoles(seed, n);
  return {
    nonce,
    players: roles.map((role, id) => ({ id, role, alive: true })),
    phase: "night",
    round: 1,
    pending: [],
    investigations: [],
    lastNight: null,
    winner: null,
  };
}

/**
 * Apply one structured decision. Validates it (throws on anything illegal or out of order),
 * records it, and — once every expected actor for the open phase has acted — resolves the
 * phase and advances. Pure: returns a new state, never mutates the input.
 */
export function applyDecision(state: GameState, d: Decision): GameState {
  assertLegal(state, d);
  const pending: PendingAction[] = [...state.pending, { player: d.player, action: d.action, target: d.target }];

  const expected = expectedActors(state);
  const acted = new Set(pending.map((a) => a.player));
  const complete = expected.size > 0 && [...expected].every((id) => acted.has(id));
  if (!complete) return { ...state, pending };

  return state.phase === "night" ? resolveNight(state, pending) : resolveDay(state, pending);
}

/** The decided winning faction, or `null` while the game is ongoing. */
export const winner = (state: GameState): Faction | null => state.winner;

/**
 * Fold an ordered sequence of decisions from a fresh game, snapshotting state after each
 * phase resolution. Returns those per-resolution snapshots and the final winner.
 */
export function runMatch(
  seed: string,
  n: number,
  nonce: string,
  decisions: readonly Decision[],
): { states: GameState[]; winner: Faction | null } {
  let state = initState(seed, n, nonce);
  const states: GameState[] = [];
  for (const d of decisions) {
    const before = state;
    state = applyDecision(state, d);
    if (state.phase !== before.phase) states.push(state); // a phase resolved
  }
  return { states, winner: state.winner };
}
