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
export type MarketState = "OPEN" | "LOCKED" | "SETTLED" | "REFUND";

/** Snapshot of the on-chain market, read by the server from getters and pushed to clients. */
export interface MarketSnapshot {
  readonly state: MarketState;
  /** True only while the chain is actually in [open, close) — i.e. when a bet is accepted. */
  readonly bettingLive?: boolean;
  /**
   * Epoch ms when betting is projected to close (server estimate from remaining blocks × block
   * rate). Present only while betting is live; drives the client-side countdown.
   */
  readonly closesAt?: number;
  /**
   * Every market (the headline FACTION market included) is a categorical prop — the faction verdict is
   * the FACTION prop's `state`/`winningOutcome`. Absent until the server reads the props.
   */
  readonly props?: readonly PropSnapshot[];
}

/**
 * A per-match CATEGORICAL side market. Bettors stake on ONE of `numOutcomes` outcomes; `pools[o]` is
 * outcome o's pool (CHIP decimal string). Once SETTLED, `state` is RESOLVED (a single `winningOutcome`
 * won — its backers split the pot) or VOID (nobody backed the winner → every stake refunded). Kinds:
 *   - PLAYER_FATE     : "what happens to seat `param`?" Outcomes are death-round buckets —
 *                       0 survives, 1 out R1, 2 out R2, 3 out R3, 4 out R4+ (numOutcomes == 5).
 *   - ROUND_VOTED_OUT : "who is voted out in round `param`'s day vote?" Outcomes 0..n-1 are the seats,
 *                       the last (numOutcomes-1) is "no one (tie / no elimination)" — a recurring
 *                       per-round market, one per round, floated as the match advances.
 *   - NIGHT_KILL      : "who falls before dawn in round `param`'s night?" Same outcome shape as
 *                       ROUND_VOTED_OUT (seats + a "no one" for a blocked kill / quiet night). Opens at
 *                       nightfall and freezes at dawn — the night-side twin of ROUND_VOTED_OUT.
 *   - DETECTIVE_CLAIM : "is seat `param`, who went public as the Detective, telling the truth or bluffing?"
 *                       A SINGLE binary market — outcome 0 = BLUFF, 1 = REAL DETECTIVE. Floated on the
 *                       first public claim; stays open until settle (resolves from the revealed roles).
 *   - MAFIA_SEAT      : "who is the Mafia?" A SINGLE categorical market — one outcome per seat
 *                       (numOutcomes == playerCount, param unused). Floated once at match start; stays
 *                       open until settle (resolves to the Mafia seat from the revealed roles).
 *   - FACTION         : "which faction wins?" The headline market — a SINGLE binary market (outcome
 *                       0 = TOWN wins, 1 = MAFIA wins, param unused). Floated once at match start; stays
 *                       open until settle (resolves to the winning faction; a mistrial Voids → refund).
 * Mirrors MafiaMarket.getProp() / server wire `PropSnapshot`.
 */
export interface PropSnapshot {
  readonly index: number;
  readonly kind: "PLAYER_FATE" | "ROUND_VOTED_OUT" | "NIGHT_KILL" | "DETECTIVE_CLAIM" | "MAFIA_SEAT" | "FACTION";
  /** PLAYER_FATE: the seat. ROUND_VOTED_OUT / NIGHT_KILL: the 1-based round. DETECTIVE_CLAIM: the claiming seat. MAFIA_SEAT / FACTION: unused. */
  readonly param: number;
  readonly numOutcomes: number;
  /** Per-outcome pools (CHIP decimal strings), length == numOutcomes. */
  readonly pools: readonly string[];
  /** True once the host froze this market on-chain (its outcome became public) — no more bets accepted. */
  readonly closed?: boolean;
  /** Set once SETTLED: RESOLVED (winningOutcome won) or VOID (refund all). Absent while unresolved. */
  readonly state?: "RESOLVED" | "VOID";
  /** The winning outcome index, set when state == RESOLVED. */
  readonly winningOutcome?: number;
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
  // Daytime deliberation: each living seat's unsigned public discussion, streamed before the vote
  // pass. Day speech only (never runs at night), so it carries no role.
  | { type: "discussion"; seat: number; round: number; speech: string; state: PublicGameState }
  // A CLAIM beat: a seat goes public as the Detective (a genuine reveal OR a Mafia fake-claim), promoted
  // from a discussion turn to its own stage scene. Leaks NO role — whether the claim is TRUE settles only
  // from the revealed roles (the "real or bluff?" market). `counter` is true when a rival claim already
  // happened this match (a public fork). `role` is always DETECTIVE (the only claim with a market today).
  | { type: "claim"; seat: number; round: number; role: "DETECTIVE"; counter: boolean; speech: string; state: PublicGameState }
  // Night is never streamed per-actor (it would leak roles). `night` marks nightfall; `dawn`
  // reports the publicly-known death(s) at first light plus `saved` — the COUNT of lives shielded
  // by a protection (a blocked kill), never the seat. See server/src/orchestrator.ts.
  | { type: "night"; round: number }
  | { type: "dawn"; round: number; killed: number[]; saved: number; state: PublicGameState }
  // A synchronized IN-LOOP betting window: the match pauses and one side market is spotlighted so a
  // dramatic moment becomes a betting moment. Rendered as a stage beat (plays in-line with the dialogue)
  // that holds until `endsAt`; `NIGHT_KILL` opens at nightfall (freezes before dawn), `ROUND_VOTED_OUT`
  // after the discussion pass (freezes before votes), `DETECTIVE_CLAIM` on a claim (stays open to settle).
  | {
      type: "bet_window";
      market: "NIGHT_KILL" | "ROUND_VOTED_OUT" | "DETECTIVE_CLAIM";
      round: number;
      /** On-chain prop index to spotlight/bet on. */
      propIndex: number;
      /** Epoch ms the window closes — drives the countdown + the stage hold. */
      endsAt: number;
      /** Nominal window length (ms); `endsAt` is the authority. */
      durationMs: number;
      /** DETECTIVE_CLAIM: the seat whose claim the market judges. */
      seat?: number;
    }
  | { type: "reveal"; roles: Role[]; winner: Faction }
  // Match finalized on-chain. The faction verdict (and every market's payout) rides in the final `market`
  // snapshot's props — the FACTION prop resolves to MAFIA/TOWN, or Voids on a mistrial.
  | { type: "settled"; txHash?: string; transcriptCID?: string };

/** Live connection state of the feed transport. */
export type ConnStatus = "connecting" | "open" | "reconnecting";

/** A feed source: anything that lets the store subscribe to ordered WsMessages. */
export interface MatchFeed {
  /** Subscribe to messages. Returns an unsubscribe fn. */
  subscribe(onMessage: (msg: WsMessage) => void): () => void;
  /** Subscribe to transport status changes (open / reconnecting). Returns an unsubscribe fn. */
  onStatus?(cb: (status: ConnStatus) => void): () => void;
  /** Optional: begin streaming (the mock driver paces turns; a WS connects). */
  start?(): void;
  /** Whether this feed is the labeled mock replay (drives the "MOCK FEED" badge). */
  readonly isMock: boolean;
}
