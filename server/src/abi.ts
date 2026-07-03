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
  // host-only: freeze one survival market mid-match once its seat falls (payout-neutral; stops new bets on a decided seat)
  "function closeProp(uint256 matchId, uint256 propIdx)",
  // host-only: float the next round's "voted out" band (one prop per seat) as the match advances — the per-round market re-opens here.
  "function openVotedOutRound(uint256 matchId) returns (uint8 round, uint256 startIdx)",
  "function votedOutRoundsOpened(uint256 matchId) view returns (uint8)",
  // host-only: float the next round's "night kill" market at nightfall (frozen at dawn via closeProp).
  "function openNightKillRound(uint256 matchId) returns (uint8 round, uint256 startIdx)",
  "function nightKillRoundsOpened(uint256 matchId) view returns (uint8)",
  // host-only: float the single "Detective claim: real or bluff?" market for `seat` on the first public
  // claim (binary: 0=BLUFF, 1=REAL). At most one per match; stays open until settle (roles hidden mid-match).
  "function openDetectiveClaim(uint256 matchId, uint8 seat) returns (uint256 startIdx)",
  "function detectiveClaimOpened(uint256 matchId) view returns (bool)",
  "function settle(uint256 matchId, ((uint8 phase, uint32 round, uint8 player, uint8 action, uint8 target) decision, bytes rawResponseBody, uint256 contentOffset, uint256 contentLen, string reqHashHex, bytes signature)[] moves, uint8[] revealedRoles, bytes32 salt, bytes32 transcriptCID)",
  // reads (pools / state / outcome live in the Match struct)
  "function matches(uint256) view returns (uint8 state, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot, address teeSigner, string providerType, string providerIdentity, string tlsFingerprint, string nonce, uint8 playerCount, uint128 poolYes, uint128 poolNo, uint8 outcome, uint128 netPot, uint128 winningPool, bytes32 transcriptCID, uint16 feeBps, uint16 feeBpsDraw)",
  // categorical side markets ("props"): one PlayerFate market per seat + one RoundVotedOut market per
  // opened round, auto-created/floated from the match and resolved from the same verified run at
  // settle(). The server only READS these and pushes the per-outcome pools/winner to clients; the prop
  // bets/claims are sent from the spectator wallet (frontend).
  "function propCount(uint256 matchId) view returns (uint256)",
  "function getProp(uint256 matchId, uint256 propIdx) view returns (tuple(uint8 kind, uint8 param, uint8 numOutcomes, bool closed, uint8 state, uint8 winningOutcome, uint128 netPot, uint128 winningPool, uint128[] pools))",
  // events
  "event MatchCreated(uint256 indexed matchId, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot, address teeSigner, uint8 playerCount, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock)",
  "event BettingLocked(uint256 indexed matchId, uint128 finalPoolYes, uint128 finalPoolNo)",
  "event VotedOutRoundOpened(uint256 indexed matchId, uint8 round, uint256 startIdx)",
  "event NightKillRoundOpened(uint256 indexed matchId, uint8 round, uint256 startIdx)",
  "event DetectiveClaimOpened(uint256 indexed matchId, uint256 startIdx, uint8 seat)",
  "event MatchSettled(uint256 indexed matchId, uint8 outcome, uint128 netPot, bytes32 transcriptCID)",
] as const;

/** MatchState enum → wire MarketState. RefundMode is its own state (refund(), not claim()). */
export function marketStateOf(state: number): "OPEN" | "LOCKED" | "SETTLED" | "REFUND" {
  if (state === 4) return "REFUND"; // RefundMode — liveness fallback, stakes reclaimed via refund()
  if (state === 3) return "SETTLED";
  if (state === 2) return "LOCKED";
  return "OPEN"; // None/Created
}

/** Outcome enum → winning side (YES=Mafia, NO=Town). Draw/Void → undefined. */
export function winningSideOf(outcome: number): "YES" | "NO" | undefined {
  if (outcome === 1) return "YES";
  if (outcome === 2) return "NO";
  return undefined;
}

/** Outcome enum (Unset,Yes,No,Draw,Void) → wire outcome, or undefined while unresolved. */
export function outcomeOf(outcome: number): "YES" | "NO" | "DRAW" | "VOID" | undefined {
  return ({ 1: "YES", 2: "NO", 3: "DRAW", 4: "VOID" } as const)[outcome];
}

/** Categorical prop PropState enum (Unset,Resolved,Void) → wire state, or undefined while unresolved. */
export function propStateOf(state: number): "RESOLVED" | "VOID" | undefined {
  return ({ 1: "RESOLVED", 2: "VOID" } as const)[state];
}

export const ROLE_ENUM: Record<string, number> = { MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 };
