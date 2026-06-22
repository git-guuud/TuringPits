/**
 * Minimal MafiaMarket ABI — exactly the surface the spectator wallet touches.
 * Derived from contracts/contracts/MafiaMarket.sol (v3 multi-match factory) + MafiaTypes.sol.
 *
 * The frontend NEVER calls owner-only functions (createMatch / lockBetting / settle) — those
 * belong to the server (the contract owner/host). It only sends bets + claim from the connected
 * wallet and reads its OWN per-match stake. Pool sizes / state / outcome arrive over the
 * WebSocket (the server reads them from this same contract). Everything is keyed by `matchId`.
 *
 * Enums (MafiaTypes.sol): MatchState{None,Created,Locked,Settled,RefundMode}; Outcome{Unset,Yes,No,Draw,Void}.
 * "Yes" = Mafia wins.
 */
export const MAFIA_MARKET_ABI = [
  // wallet writes (parimutuel: separate fns per side; no Side arg)
  "function betYes(uint256 matchId) payable",
  "function betNo(uint256 matchId) payable",
  "function claim(uint256 matchId)",
  // Liveness fallback: reclaim stake when the host never settled (state == RefundMode).
  "function refund(uint256 matchId)",
  // per-wallet, per-match reads
  "function stakeYes(uint256 matchId, address user) view returns (uint128)",
  "function stakeNo(uint256 matchId, address user) view returns (uint128)",
  "function claimed(uint256 matchId, address user) view returns (bool)",
  "function MIN_BET() view returns (uint256)",
  // full match struct — used as a read-only fallback to detect terminal state if the server stops
  // pushing (e.g. it crashed, or the match entered RefundMode on-chain).
  "function matches(uint256) view returns (uint8 state, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot, address teeSigner, string providerType, string providerIdentity, string tlsFingerprint, string nonce, uint8 playerCount, uint128 poolYes, uint128 poolNo, uint8 outcome, uint128 netPot, uint128 winningPool, bytes32 transcriptCID, uint16 feeBps, uint16 feeBpsDraw)",
] as const;
