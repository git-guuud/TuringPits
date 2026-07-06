/**
 * MafiaMarket v3 ABI — the host (owner) surface the server drives, plus the reads it pushes.
 * Hand-written from contracts/contracts/MafiaMarket.sol + MafiaTypes.sol so the server has no
 * build-time dependency on hardhat artifacts. Keep in sync with the contract.
 *
 * Enums: MatchState{None,Created,Locked,Settled,RefundMode}. Every market (headline faction included) is
 * one categorical Prop{state:Unset,Resolved,Void} — there is no Outcome enum. PropKind: PlayerFate=0,
 * RoundVotedOut=1, NightKill=2, DetectiveClaim=3, MafiaSeat=4, Faction=5.
 * Role enum (revealedRoles): MAFIA=0,DOCTOR=1,DETECTIVE=2,TOWN=3. Decision tuple order:
 * (phase:uint8, round:uint32, player:uint8, action:uint8, target:uint8).
 */
export const MAFIA_MARKET_ABI = [
  // owner / host
  "function owner() view returns (address)",
  "function nextMatchId() view returns (uint256)",
  "function createMatch((bytes32 roleCommit, bytes32 personaPoolRoot, address teeSigner, string providerType, string providerIdentity, string tlsFingerprint, string nonce, uint8 playerCount, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock, uint16 feeBps) p) returns (uint256)",
  "function lockBetting(uint256 matchId)",
  // host-only: freeze one market mid-match once its outcome is public — a round's vote-out / night-kill
  // (payout-neutral; stops new bets on a decided market)
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
  // host-only: float the single "Who is the Mafia?" market (one outcome per seat) once at match start;
  // stays open until settle (roles hidden mid-match). Resolves to the Mafia seat from the revealed roles.
  "function openMafiaSeatMarket(uint256 matchId) returns (uint256 startIdx)",
  "function mafiaSeatOpened(uint256 matchId) view returns (bool)",
  // host-only: float the headline "which faction wins?" market (0=TOWN, 1=MAFIA) once at match start;
  // stays open until settle. Resolves to the winning faction from the verified run (mistrial → Void).
  "function openFactionMarket(uint256 matchId) returns (uint256 startIdx)",
  "function factionMarketOpened(uint256 matchId) view returns (bool)",
  "function settle(uint256 matchId, ((uint8 phase, uint32 round, uint8 player, uint8 action, uint8 target) decision, bytes rawResponseBody, uint256 contentOffset, uint256 contentLen, string reqHashHex, bytes signature)[] moves, uint8[] revealedRoles, bytes32 salt, bytes32 transcriptCID)",
  // reads (match lifecycle state lives in the Match struct; all pools/outcomes live in the props)
  "function matches(uint256) view returns (uint8 state, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot, address teeSigner, string providerType, string providerIdentity, string tlsFingerprint, string nonce, uint8 playerCount, bytes32 transcriptCID, uint16 feeBps)",
  // categorical side markets ("props"): one RoundVotedOut + one NightKill market per opened round, plus the
  // on-demand singles (Faction / MafiaSeat / DetectiveClaim), auto-created/floated from the match and
  // resolved from the same verified run at settle(). (The per-seat PlayerFate/survival market is not floated
  // for now.) The server only READS these and pushes the per-outcome pools/winner to clients; the prop
  // bets/claims are sent from the spectator wallet (frontend).
  "function propCount(uint256 matchId) view returns (uint256)",
  "function getProp(uint256 matchId, uint256 propIdx) view returns (tuple(uint8 kind, uint8 param, uint8 numOutcomes, bool closed, uint8 state, uint8 winningOutcome, uint128 netPot, uint128 winningPool, uint128[] pools))",
  // events
  "event MatchCreated(uint256 indexed matchId, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot, address teeSigner, uint8 playerCount, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock)",
  "event BettingLocked(uint256 indexed matchId)",
  "event VotedOutRoundOpened(uint256 indexed matchId, uint8 round, uint256 startIdx)",
  "event NightKillRoundOpened(uint256 indexed matchId, uint8 round, uint256 startIdx)",
  "event DetectiveClaimOpened(uint256 indexed matchId, uint256 startIdx, uint8 seat)",
  "event MafiaSeatMarketOpened(uint256 indexed matchId, uint256 startIdx)",
  "event FactionMarketOpened(uint256 indexed matchId, uint256 startIdx)",
  "event MatchSettled(uint256 indexed matchId, bytes32 transcriptCID)",
] as const;

/** MatchState enum → wire MarketState. RefundMode is its own state (refundProp(), not claimProp()). */
export function marketStateOf(state: number): "OPEN" | "LOCKED" | "SETTLED" | "REFUND" {
  if (state === 4) return "REFUND"; // RefundMode — liveness fallback, stakes reclaimed via refundProp()
  if (state === 3) return "SETTLED";
  if (state === 2) return "LOCKED";
  return "OPEN"; // None/Created
}

// The faction verdict is no longer a bespoke Match field — it's the FACTION prop's state/winningOutcome,
// projected like any other market via propStateOf. (winningSideOf/outcomeOf are gone with the Outcome enum.)

/** Categorical prop PropState enum (Unset,Resolved,Void) → wire state, or undefined while unresolved. */
export function propStateOf(state: number): "RESOLVED" | "VOID" | undefined {
  return ({ 1: "RESOLVED", 2: "VOID" } as const)[state];
}

export const ROLE_ENUM: Record<string, number> = { MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 };
