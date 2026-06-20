/**
 * MafiaMarket v3 ABI — the host (owner) surface the server drives, plus the reads it pushes.
 * Hand-written from contracts/contracts/MafiaMarket.sol + MafiaTypes.sol so the server has no
 * build-time dependency on hardhat artifacts. Keep in sync with the contract.
 *
 * Enums: MatchState{None,Created,Locked,Settled,RefundMode}; Outcome{Unset,Yes,No,Draw,Void}.
 * Role enum (revealedRoles): MAFIA=0,DOCTOR=1,DETECTIVE=2,TOWN=3. Decision tuple order:
 * (phase:uint8, round:uint32, player:uint8, action:uint8, target:uint8).
 */
export const MAFIA_MARKET_ABI = [
  // owner / host
  "function owner() view returns (address)",
  "function nextMatchId() view returns (uint256)",
  "function createMatch((bytes32 roleCommit, bytes32 personaPoolRoot, address teeSigner, string providerType, string providerIdentity, string tlsFingerprint, string nonce, uint8 playerCount, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock, uint16 feeBps, uint16 feeBpsDraw) p) returns (uint256)",
  "function lockBetting(uint256 matchId)",
  "function settle(uint256 matchId, ((uint8 phase, uint32 round, uint8 player, uint8 action, uint8 target) decision, bytes rawResponseBody, uint256 contentOffset, uint256 contentLen, string reqHashHex, bytes signature)[] moves, uint8[] revealedRoles, bytes32 salt, bytes32 transcriptCID)",
  // reads (pools / state / outcome live in the Match struct)
  "function matches(uint256) view returns (uint8 state, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot, address teeSigner, string providerType, string providerIdentity, string tlsFingerprint, string nonce, uint8 playerCount, uint128 poolYes, uint128 poolNo, uint8 outcome, uint128 netPot, uint128 winningPool, bytes32 transcriptCID, uint16 feeBps, uint16 feeBpsDraw)",
  // events
  "event MatchCreated(uint256 indexed matchId, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot, address teeSigner, uint8 playerCount, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock)",
  "event BettingLocked(uint256 indexed matchId, uint128 finalPoolYes, uint128 finalPoolNo)",
  "event MatchSettled(uint256 indexed matchId, uint8 outcome, uint128 netPot, bytes32 transcriptCID)",
] as const;

/** MatchState enum → wire MarketState. */
export function marketStateOf(state: number): "OPEN" | "LOCKED" | "SETTLED" {
  if (state >= 3) return "SETTLED"; // Settled or RefundMode
  if (state === 2) return "LOCKED";
  return "OPEN"; // None/Created
}

/** Outcome enum → winning side (YES=Mafia, NO=Town). Draw/Void → undefined. */
export function winningSideOf(outcome: number): "YES" | "NO" | undefined {
  if (outcome === 1) return "YES";
  if (outcome === 2) return "NO";
  return undefined;
}

export const ROLE_ENUM: Record<string, number> = { MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 };
