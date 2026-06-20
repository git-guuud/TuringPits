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
  // per-wallet, per-match reads
  "function stakeYes(uint256 matchId, address user) view returns (uint128)",
  "function stakeNo(uint256 matchId, address user) view returns (uint128)",
  "function claimed(uint256 matchId, address user) view returns (bool)",
  "function MIN_BET() view returns (uint256)",
] as const;
