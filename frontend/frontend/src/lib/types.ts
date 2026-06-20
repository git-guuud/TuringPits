/**
 * Wire types for the Turing Pits Live Arena.
 *
 * These are the messages the frontend consumes. They are deliberately structural
 * MIRRORS of the real repository types so that "switch from mock to real backend"
 * is a one-line swap (point the feed at a WebSocket instead of the replay driver) —
 * the message shapes do not change.
 *
 * Provenance (do not drift from these):
 *   - Role, Faction, Phase, Action, Decision  ← engine/src/types.ts
 *   - Persona, Attestation (source/signer)     ← players/src/types.ts
 *   - PublicGameState                          ← server-side redaction of engine GameState
 *                                                 (engine GameState minus hidden `role`)
 *   - MarketSnapshot / RecordCommit            ← MafiaMarket.sol public getters
 *
 * IMPORTANT: a player's `role` is NEVER sent during play (it would leak the Mafia).
 * Roles arrive only in the `reveal` message at the end. The server's `toPublicState`
 * MUST produce exactly `PublicGameState` below.
 */

// ── engine/src/types.ts mirrors ──────────────────────────────────────────────
export type Role = "MAFIA" | "DOCTOR" | "DETECTIVE" | "TOWN";
export type Faction = "MAFIA" | "TOWN";
export type Phase = "night" | "day";
export type Action = "kill" | "save" | "investigate" | "vote";

/** Mirrors engine `Decision` (the structured payload the contract consumes). */
export interface Decision {
  readonly nonce: string;
  readonly phase: Phase;
  readonly round: number;
  readonly player: number;
  readonly action: Action;
  readonly target: number;
}

// ── players/src/types.ts mirrors ─────────────────────────────────────────────
/** Mirrors players `Persona`. */
export interface Persona {
  readonly seat: number;
  readonly name: string;
  readonly blurb: string;
}

/** Where a move's signature came from. `"0g-tee"` = real; `"MOCK-local"` = labeled local key. */
export type AttestationSource = "0g-tee" | "MOCK-local";

/**
 * The PUBLIC projection of an attestation. The full `Attestation` (rawResponseBody,
 * signature, reqHashHex, offsets) is only needed server-side for `settle()` calldata
 * (`toSettlementMove`); the browser only needs to display provenance.
 */
export interface PublicAttestation {
  readonly source: AttestationSource;
  readonly signerAddress: string;
}

// ── server-side redaction of engine GameState ────────────────────────────────
/** One seat as the public sees it during play: id + alive only. `role` is withheld. */
export interface PublicSeat {
  readonly id: number;
  readonly alive: boolean;
}

/** Engine `GameState` with hidden roles (and internal pending/investigations) stripped. */
export interface PublicGameState {
  readonly nonce: string;
  readonly phase: Phase;
  /** 1-based round number. */
  readonly round: number;
  readonly players: readonly PublicSeat[];
  /** null while ongoing; set once the moderator declares a winner. */
  readonly winner: Faction | null;
}

/** A recorded turn, public projection: speech + decision + provenance. No signed bytes. */
export interface PublicTurn {
  readonly seat: number;
  readonly speech: string;
  readonly decision: Omit<Decision, "nonce">;
  readonly attestation: PublicAttestation;
}

// ── MafiaMarket.sol getters ──────────────────────────────────────────────────
export type MarketState = "OPEN" | "LOCKED" | "SETTLED";
export type Side = "YES" | "NO"; // YES = "Mafia wins"

/** Snapshot of the on-chain market, read by the server from getters and pushed to clients. */
export interface MarketSnapshot {
  readonly state: MarketState;
  /** Pools as decimal strings of 0G. */
  readonly yesPool: string;
  readonly noPool: string;
  /** Set only when SETTLED. */
  readonly winningSide?: Side;
}

/** The commitment metadata shown in THE RECORD (from openMarket args / getters). */
export interface RecordCommit {
  readonly roleCommit: string;
  readonly teeSigner: string;
  readonly providerType: string;
  readonly providerIdentity: string;
  readonly tlsFingerprint: string;
  readonly playerCount: number;
  /** 0G Storage content root of the persona pool (evidence). Absent/zero if storage off. */
  readonly personaPoolRoot?: string;
}

// ── the discriminated message union (mock driver and WS server both emit this) ──
export type WsMessage =
  | {
      type: "match_init";
      nonce: string;
      personas: Persona[];
      record: RecordCommit;
      isMock: boolean;
      /** Deployed MafiaMarket the wallet bets against (server is the owner/host). */
      marketAddress: string;
      /** The match id within the multi-match contract. */
      matchId: number;
      chainId: number;
    }
  | { type: "market"; market: MarketSnapshot }
  | { type: "turn"; turn: PublicTurn; state: PublicGameState }
  | { type: "reveal"; roles: Role[]; winner: Faction }
  | { type: "settled"; winningSide: Side; txHash?: string; transcriptCID?: string };

/** A feed source: anything that lets the store subscribe to ordered WsMessages. */
export interface MatchFeed {
  /** Subscribe to messages. Returns an unsubscribe fn. */
  subscribe(onMessage: (msg: WsMessage) => void): () => void;
  /** Optional: begin streaming (the mock driver paces turns; a WS connects). */
  start?(): void;
  /** Whether this feed is the labeled mock replay (drives the "MOCK FEED" badge). */
  readonly isMock: boolean;
}
