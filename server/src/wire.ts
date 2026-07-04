/**
 * The WebSocket wire protocol. The server is authoritative; the frontend mirrors these shapes
 * in `frontend/src/lib/types.ts`. Roles are NEVER sent during play (see redact.ts) — they
 * arrive only in `reveal` at the end.
 */
import type { Faction, Phase, Role } from "@turingpits/engine";

export interface Persona { seat: number; name: string; blurb: string }
export type AttestationSource = "0g-tee" | "MOCK-local";
export type MarketState = "OPEN" | "LOCKED" | "SETTLED" | "REFUND";
export type Side = "YES" | "NO";
/** Resolved market outcome. YES/NO pay the winners; DRAW/VOID return stakes (via claim()). */
export type Outcome = "YES" | "NO" | "DRAW" | "VOID";

export interface RecordCommit {
  roleCommit: string;
  teeSigner: string;
  providerType: string;
  providerIdentity: string;
  tlsFingerprint: string;
  playerCount: number;
  /** 0G Storage content root of the persona pool (evidence). ZeroHash/absent if storage off. */
  personaPoolRoot?: string;
}
export interface PublicSeat { id: number; alive: boolean }
export interface PublicGameState {
  nonce: string;
  phase: Phase;
  round: number;
  players: PublicSeat[];
  winner: Faction | null;
}
export interface PublicTurn {
  seat: number;
  speech: string;
  decision: { phase: Phase; round: number; player: number; action: string; target: number };
  attestation: { source: AttestationSource; signerAddress: string };
}
export interface MarketSnapshot {
  state: MarketState;
  /** True only while the chain is actually in [open, close) — i.e. when _bet() is accepted. */
  bettingLive?: boolean;
  /**
   * Epoch ms when betting is projected to close, derived from the remaining blocks to
   * bettingCloseBlock and the measured block rate. Present only while betting is live, so the
   * client can render a smooth countdown between the (coarse) market pushes. An estimate.
   */
  closesAt?: number;
  yesPool: string;
  noPool: string;
  /** Set when SETTLED. YES/NO only; DRAW/VOID carry no winning side. */
  winningSide?: Side;
  /** Set when SETTLED — the full resolution (incl. DRAW/VOID refund outcomes). */
  outcome?: Outcome;
  /** Per-match categorical side markets (one PlayerFate per seat + one RoundVotedOut per opened round). Absent until the server has read them. */
  props?: PropSnapshot[];
}

/**
 * A per-match CATEGORICAL side market, projected from the contract for the UI. Bettors stake on ONE of
 * `numOutcomes` outcomes; `pools[o]` is outcome o's pool (CHIP decimal string). Once the match settles,
 * `state` is RESOLVED (a single `winningOutcome` won — its backers split the pot) or VOID (nobody backed
 * the winning outcome → every stake refunded). Two kinds:
 *   - PLAYER_FATE     : "what happens to seat `param`?" Outcomes are death-round buckets —
 *                       0 survives, 1 out R1, 2 out R2, 3 out R3, 4 out R4+ (numOutcomes == 5).
 *   - ROUND_VOTED_OUT : "who is voted out in round `param`'s day vote?" Outcomes 0..n-1 are the seats,
 *                       the last (numOutcomes-1) is "no one (tie / no elimination)". A recurring
 *                       per-round market: one per round, opened as the match advances.
 *   - NIGHT_KILL      : "who falls before dawn in round `param`'s night?" Same outcome shape as
 *                       ROUND_VOTED_OUT (seats + a "no one" for a blocked kill / quiet night). Opens at
 *                       nightfall and freezes at dawn — the night-side twin of ROUND_VOTED_OUT.
 *   - DETECTIVE_CLAIM : "is seat `param`, who went public as the Detective, telling the truth or bluffing?"
 *                       A SINGLE binary market — outcome 0 = BLUFF, 1 = REAL DETECTIVE. Floated on the
 *                       first public claim; stays open until settle (resolves from the revealed roles).
 *   - MAFIA_SEAT      : "who is the Mafia?" A SINGLE categorical market with one outcome per seat
 *                       (numOutcomes == playerCount, param unused). Floated once at match start; stays
 *                       open until settle (resolves to the Mafia seat from the revealed roles).
 */
export interface PropSnapshot {
  index: number;
  kind: "PLAYER_FATE" | "ROUND_VOTED_OUT" | "NIGHT_KILL" | "DETECTIVE_CLAIM" | "MAFIA_SEAT";
  /** PLAYER_FATE: the seat. ROUND_VOTED_OUT / NIGHT_KILL: the 1-based round. DETECTIVE_CLAIM: the claiming seat. MAFIA_SEAT: unused. */
  param: number;
  numOutcomes: number;
  /** Per-outcome pools (CHIP decimal strings), length == numOutcomes. */
  pools: string[];
  /** True once the host froze this market on-chain (its outcome became public) — no more bets. */
  closed: boolean;
  /** Set once SETTLED: RESOLVED (winningOutcome won) or VOID (refund all). Absent while unresolved. */
  state?: "RESOLVED" | "VOID";
  /** The winning outcome index, set when state == RESOLVED. */
  winningOutcome?: number;
}

export type WsMessage =
  | { type: "match_init"; nonce: string; personas: Persona[]; record: RecordCommit; isMock: boolean; marketAddress: string; matchId: number; chainId: number }
  | { type: "market"; market: MarketSnapshot }
  | { type: "turn"; turn: PublicTurn; state: PublicGameState }
  // Daytime deliberation: the unsigned, public discussion each living seat makes before the vote.
  // Day speech only (the discussion pass never runs at night), so it leaks no role.
  | { type: "discussion"; seat: number; round: number; speech: string; state: PublicGameState }
  // A CLAIM beat: a seat goes public as the Detective (a genuine reveal OR a Mafia fake-claim). Promoted
  // from a discussion turn so the stage gives it its own scene and the "real or bluff?" market opens.
  // Leaks NO role — whether the claim is TRUE settles only from the revealed roles. `counter` is true
  // when an earlier claim already happened this match (a rival Detective-claim = a public fork), which is
  // itself public. The claimed role is always the Detective (the only claim with a market today).
  | { type: "claim"; seat: number; round: number; role: "DETECTIVE"; counter: boolean; speech: string; state: PublicGameState }
  // Night is never streamed per-actor (it would reveal who holds which role). A single `night`
  // beat marks nightfall; a `dawn` beat reports only the publicly-known death at first light, plus
  // `saved` — the COUNT of lives shielded by a protection (a blocked kill), never the seat, so the
  // Doctor cannot be triangulated from the stream.
  | { type: "night"; round: number }
  | { type: "dawn"; round: number; killed: number[]; saved: number; state: PublicGameState }
  // A synchronized IN-LOOP betting window — the match PAUSES and one side market is spotlighted so a
  // dramatic beat becomes a betting beat. Emitted in-line with the dialogue (it is a stage beat), and
  // the loop actually holds until `endsAt`. `NIGHT_KILL` opens at nightfall and freezes before dawn;
  // `ROUND_VOTED_OUT` opens after the discussion pass and freezes before votes are cast; `DETECTIVE_CLAIM`
  // opens on a public claim and stays open (it resolves only from the revealed roles at settle). Betting
  // is still gated on the live market snapshot (`props[].closed`), so `endsAt` is presentation, not a lock.
  | {
      type: "bet_window";
      market: "NIGHT_KILL" | "ROUND_VOTED_OUT" | "DETECTIVE_CLAIM";
      round: number;
      /** On-chain prop index to bet on (the recurring kinds interleave — address by index, not a formula). */
      propIndex: number;
      /** Epoch ms the window closes — drives the countdown and the stage hold. */
      endsAt: number;
      /** Nominal window length (ms); `endsAt` is the authority. */
      durationMs: number;
      /** DETECTIVE_CLAIM: the seat whose claim the market judges (for copy). */
      seat?: number;
    }
  | { type: "reveal"; roles: Role[]; winner: Faction }
  // outcome is always present; winningSide only for YES/NO. DRAW/VOID return stakes (claim()).
  | { type: "settled"; outcome: Outcome; winningSide?: Side; feeBpsDraw?: number; txHash?: string; transcriptCID?: string };
