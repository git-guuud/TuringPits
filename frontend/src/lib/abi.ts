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
  // wallet writes (parimutuel: separate fns per side; no Side arg). Bets are denominated in the
  // CHIP bet token (MockBetToken) — the bettor approves the market, then stakes `amount` base units.
  "function betYes(uint256 matchId, uint128 amount)",
  "function betNo(uint256 matchId, uint128 amount)",
  "function claim(uint256 matchId)",
  // The ERC20 every wager/payout is denominated in — read once to find the CHIP token to approve.
  "function betToken() view returns (address)",
  // Liveness fallback: reclaim stake when the host never settled (state == RefundMode).
  "function refund(uint256 matchId)",
  // Permissionless: flip an abandoned match (Created/Locked) into RefundMode once its deadline
  // passes, so its bettors can refund() without depending on the host. Normally the server does
  // this, but anyone can — the UI exposes it as a fallback for prior matches.
  "function enterRefundMode(uint256 matchId)",
  // per-wallet, per-match reads
  "function stakeYes(uint256 matchId, address user) view returns (uint128)",
  "function stakeNo(uint256 matchId, address user) view returns (uint128)",
  "function claimed(uint256 matchId, address user) view returns (bool)",
  // categorical side markets ("props"): PlayerFate (propIdx == seat) + the per-round RoundVotedOut and
  // NightKill markets, resolved from the same verified run at settle(). The wallet bets on ONE outcome
  // and claims by propIdx (the kind/param/winner are read off getProp); the server is the only caller of
  // openVotedOutRound / openNightKillRound.
  "function betProp(uint256 matchId, uint256 propIdx, uint8 outcome, uint128 amount)",
  "function claimProp(uint256 matchId, uint256 propIdx)",
  "function refundProp(uint256 matchId, uint256 propIdx)",
  "function propCount(uint256 matchId) view returns (uint256)",
  "function getProp(uint256 matchId, uint256 propIdx) view returns (tuple(uint8 kind, uint8 param, uint8 numOutcomes, bool closed, uint8 state, uint8 winningOutcome, uint128 netPot, uint128 winningPool, uint128[] pools))",
  "function propStake(uint256 matchId, uint256 propIdx, uint8 outcome, address user) view returns (uint128)",
  "function propClaimed(uint256 matchId, uint256 propIdx, address user) view returns (bool)",
  "function MIN_BET() view returns (uint256)",
  // total matches ever created — the History screen walks [0, nextMatchId) to list past battles.
  "function nextMatchId() view returns (uint256)",
  // full match struct — used as a read-only fallback to detect terminal state if the server stops
  // pushing (e.g. it crashed, or the match entered RefundMode on-chain).
  "function matches(uint256) view returns (uint8 state, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot, address teeSigner, string providerType, string providerIdentity, string tlsFingerprint, string nonce, uint8 playerCount, uint128 poolYes, uint128 poolNo, uint8 outcome, uint128 netPot, uint128 winningPool, bytes32 transcriptCID, uint16 feeBps, uint16 feeBpsDraw)",
] as const;

/**
 * Minimal MockBetToken (CHIP) ABI — the wallet surface for the betting currency. `faucet()` mints
 * free test CHIP (demo-only, # MOCK), `approve` lets the market pull a wager, and balanceOf/allowance
 * back the menu balance display + the approve-before-bet flow. Derived from contracts/MockBetToken.sol.
 */
export const MOCK_BET_TOKEN_ABI = [
  "function faucet()",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function FAUCET_AMOUNT() view returns (uint256)",
] as const;
