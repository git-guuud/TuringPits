/**
 * The WebSocket wire protocol. The server is authoritative; the frontend mirrors these shapes
 * in `frontend/src/lib/types.ts`. Roles are NEVER sent during play (see redact.ts) — they
 * arrive only in `reveal` at the end.
 */
import type { Faction, Phase, Role } from "@turingpits/engine";

export interface Persona { seat: number; name: string; blurb: string }
export type AttestationSource = "0g-tee" | "MOCK-local";
export type MarketState = "OPEN" | "LOCKED" | "SETTLED";
export type Side = "YES" | "NO";

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
  yesPool: string;
  noPool: string;
  winningSide?: Side;
}

export type WsMessage =
  | { type: "match_init"; nonce: string; personas: Persona[]; record: RecordCommit; isMock: boolean; marketAddress: string; matchId: number; chainId: number }
  | { type: "market"; market: MarketSnapshot }
  | { type: "turn"; turn: PublicTurn; state: PublicGameState }
  | { type: "reveal"; roles: Role[]; winner: Faction }
  | { type: "settled"; winningSide: Side; txHash?: string; transcriptCID?: string };
