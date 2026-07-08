/**
 * Minimal MafiaMarket ABI — exactly the surface the spectator wallet touches.
 * Derived from contracts/contracts/MafiaMarket.sol (v3 multi-match factory) + MafiaTypes.sol.
 *
 * The frontend NEVER calls owner-only functions (createMatch / lockBetting / settle) — those
 * belong to the server (the contract owner/host). It only sends bets + claim from the connected
 * wallet and reads its OWN per-match stake. Pool sizes / market state arrive over the WebSocket
 * (the server reads them from this same contract). Everything is keyed by `matchId`.
 *
 * Enums (MafiaTypes.sol): MatchState{None,Created,Locked,Settled,RefundMode}. EVERY market — the
 * headline faction market included — is one categorical Prop{state:Unset,Resolved,Void}; there is no
 * bespoke Outcome enum. PropKind: PlayerFate=0, RoundVotedOut=1, NightKill=2, DetectiveClaim=3,
 * MafiaSeat=4, Faction=5. For Faction, outcome 0 = TOWN wins, 1 = MAFIA wins.
 */
export const MAFIA_MARKET_ABI = [
  // The ERC20 every wager/payout is denominated in — read once to find the CHIP token to approve.
  "function betToken() view returns (address)",
  // Permissionless: flip an abandoned match (Created/Locked) into RefundMode once its deadline
  // passes, so its bettors can refundProp() without depending on the host. Normally the server does
  // this, but anyone can — the UI exposes it as a fallback for prior matches.
  "function enterRefundMode(uint256 matchId)",
  // categorical side markets ("props") — the ONLY betting surface. PlayerFate (propIdx == seat), the
  // per-round RoundVotedOut / NightKill markets, DetectiveClaim, MafiaSeat, and the headline Faction
  // market are all props, resolved from the same verified run at settle(). The wallet bets on ONE
  // outcome and claims/refunds by propIdx (the kind/param/winner are read off getProp); the server is
  // the only caller of the owner-only open* floaters.
  "function betProp(uint256 matchId, uint256 propIdx, uint8 outcome, uint128 amount)",
  "function claimProp(uint256 matchId, uint256 propIdx)",
  "function refundProp(uint256 matchId, uint256 propIdx)",
  // One-tap "collect all winnings": batchClaim pays every listed winning market (skipping any the caller
  // can't collect) in a single tx; batchRefund is the RefundMode mirror. Both revert only if nothing was
  // collectable. Emits BatchClaimed(matchId, user, marketsPaid, total) alongside per-market Prop* events.
  "function batchClaim(uint256 matchId, uint256[] propIdxs)",
  "function batchRefund(uint256 matchId, uint256[] propIdxs)",
  "function propCount(uint256 matchId) view returns (uint256)",
  "function getProp(uint256 matchId, uint256 propIdx) view returns (tuple(uint8 kind, uint8 param, uint8 numOutcomes, bool closed, uint8 state, uint8 winningOutcome, uint128 netPot, uint128 winningPool, uint128[] pools))",
  "function propStake(uint256 matchId, uint256 propIdx, uint8 outcome, address user) view returns (uint128)",
  "function propClaimed(uint256 matchId, uint256 propIdx, address user) view returns (bool)",
  // Batch read views — collapse a "read every market" / "read one wallet's whole position" / "rank every
  // bettor" fan-out into ONE eth_call each, so a screen doesn't trip the public RPC's load-shedding.
  //   getProps        — the whole prop array (replaces a propCount-wide getProp fan-out; no-wallet path).
  //   getUserMatch    — every market's state + THIS wallet's per-outcome stakes + claimed, in one call
  //                     (replaces propCount × (getProp + propClaimed + numOutcomes × propStake)).
  //   getUserMatchNets — each listed wallet's (staked, returned) on the match — the whole leaderboard in
  //                     one call; `returned` equals what claimProp/batchClaim would actually pay.
  // Only present on the current market deployment; older contracts revert (no such selector), so the
  // readers below try these first and fall back to the legacy per-call reads.
  "function getProps(uint256 matchId) view returns (tuple(uint8 kind, uint8 param, uint8 numOutcomes, bool closed, uint8 state, uint8 winningOutcome, uint128 netPot, uint128 winningPool, uint128[] pools)[])",
  "function getUserMatch(uint256 matchId, address user) view returns (tuple(uint8 kind, uint8 param, uint8 numOutcomes, bool closed, uint8 state, uint8 winningOutcome, uint128 netPot, uint128 winningPool, uint128[] pools, uint128[] stakes, bool claimed)[])",
  "function getUserMatchNets(uint256 matchId, address[] users) view returns (tuple(uint128 staked, uint128 returned)[])",
  "function MIN_BET() view returns (uint256)",
  // total matches ever created — the History screen walks [0, nextMatchId) to list past battles.
  "function nextMatchId() view returns (uint256)",
  // full match struct — used as a read-only fallback to detect terminal state if the server stops
  // pushing (e.g. it crashed, or the match entered RefundMode on-chain). Pools/outcomes live in the props.
  "function matches(uint256) view returns (uint8 state, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot, address teeSigner, string providerType, string providerIdentity, string tlsFingerprint, string nonce, uint8 playerCount, bytes32 transcriptCID, uint16 feeBps)",
  // Emitted on every wager — the ONLY way to enumerate who bet on a match (propStake is keyed by a
  // known address, not iterable). `matchId` + `user` are indexed, so a topic-filtered queryFilter over
  // one match returns exactly its bettors — the match leaderboard reads these to build its roster.
  "event PropBetPlaced(uint256 indexed matchId, uint256 indexed propIdx, address indexed user, uint8 outcome, uint128 amount, uint128 newPool)",
  // Emitted once when a match is created — used only to bound the PropBetPlaced log query to the
  // match's lifetime (its creation block → head) so we never scan the whole chain.
  "event MatchCreated(uint256 indexed matchId, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot, address teeSigner, uint8 playerCount, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock)",
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
