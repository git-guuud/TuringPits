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
  /** Per-seat survival side markets (one per seat). Absent until the server has read them. */
  props?: PropSnapshot[];
}

/**
 * A per-seat survival side market, projected from the contract for the UI. YES = "this seat
 * survives to the end". Pools are CHIP decimal strings; `outcome` is set once the match settles
 * (YES = survived, NO = fell, VOID = nobody backed the winning side → refund).
 */
export interface PropSnapshot {
  index: number;
  kind: "SURVIVAL";
  seat: number;
  yesPool: string;
  noPool: string;
  /** True once the host froze this seat's market on-chain (the seat fell) — no more bets accepted. */
  closed: boolean;
  outcome?: Outcome;
}

export type WsMessage =
  | { type: "match_init"; nonce: string; personas: Persona[]; record: RecordCommit; isMock: boolean; marketAddress: string; matchId: number; chainId: number }
  | { type: "market"; market: MarketSnapshot }
  | { type: "turn"; turn: PublicTurn; state: PublicGameState }
  // Daytime deliberation: the unsigned, public discussion each living seat makes before the vote.
  // Day speech only (the discussion pass never runs at night), so it leaks no role.
  | { type: "discussion"; seat: number; round: number; speech: string; state: PublicGameState }
  // Night is never streamed per-actor (it would reveal who holds which role). A single `night`
  // beat marks nightfall; a `dawn` beat reports only the publicly-known death at first light.
  | { type: "night"; round: number }
  | { type: "dawn"; round: number; killed: number[]; state: PublicGameState }
  | { type: "reveal"; roles: Role[]; winner: Faction }
  // outcome is always present; winningSide only for YES/NO. DRAW/VOID return stakes (claim()).
  | { type: "settled"; outcome: Outcome; winningSide?: Side; feeBpsDraw?: number; txHash?: string; transcriptCID?: string };
