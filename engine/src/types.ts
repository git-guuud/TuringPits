/** Shared types for the deterministic Mafia moderator. */

/** Role assigned to a seat. TOWN, DOCTOR, DETECTIVE are all TOWN-aligned for win purposes. */
export type Role = "MAFIA" | "DOCTOR" | "DETECTIVE" | "TOWN";

/** The two factions a market can settle on. */
export type Faction = "MAFIA" | "TOWN";

export type Phase = "night" | "day";

export type Action = "kill" | "save" | "investigate" | "vote";

/**
 * A structured decision — the constrained payload the TEE signs and the Solidity
 * state machine consumes. Free-form speech lives elsewhere (not load-bearing).
 */
export interface Decision {
  /** Per-match value binding the decision to one game (cross-game replay resistance). */
  readonly nonce: string;
  readonly phase: Phase;
  /** 1-based round number. */
  readonly round: number;
  /** Acting seat index. */
  readonly player: number;
  readonly action: Action;
  /** Target seat index. */
  readonly target: number;
}

/** Per-seat state. */
export interface PlayerState {
  readonly id: number;
  readonly role: Role;
  readonly alive: boolean;
}

/** A detective investigation result, recorded for the transcript/UI (no mechanical effect). */
export interface Investigation {
  readonly round: number;
  readonly detective: number;
  readonly target: number;
  readonly faction: Faction;
}

/**
 * Public-safe summary of the most recently resolved night. It records only what the table may
 * legitimately see — WHO fell and HOW MANY lives were shielded — never the actors or their roles.
 * `saved` lists the seats that were attacked but protected (a kill neutralized by the Doctor); the
 * server narrates a blocked kill from that COUNT alone (see `server/src/night.ts`), so no night
 * action or role leaks to spectators. `null` until the first night resolves.
 */
export interface NightOutcome {
  /** The round whose night this summarizes. */
  readonly round: number;
  /** Seats killed this night. Also derivable from the alive-set diff — kept here for a self-describing summary. */
  readonly killed: readonly number[];
  /** Seats attacked but shielded by a protection: a kill that was neutralized. */
  readonly saved: readonly number[];
}

/**
 * A single pending action submitted during the currently-open phase, awaiting resolution.
 */
export interface PendingAction {
  readonly player: number;
  readonly action: Action;
  readonly target: number;
}

/**
 * Full moderator state. Immutable — `applyDecision` returns a new value.
 */
export interface GameState {
  readonly nonce: string;
  readonly players: readonly PlayerState[];
  readonly phase: Phase;
  readonly round: number;
  /** Actions submitted in the current open phase, not yet resolved. */
  readonly pending: readonly PendingAction[];
  /** All detective investigation results so far. */
  readonly investigations: readonly Investigation[];
  /** Summary of the most recently resolved night (who fell, how many lives were shielded). Null until night 1 resolves. */
  readonly lastNight: NightOutcome | null;
  /** Decided winner, or null while the game is ongoing. */
  readonly winner: Faction | null;
}
