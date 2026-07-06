// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MafiaTypes.sol";
import "./lib/DecisionCodec.sol";
import "./lib/TeeEnvelope.sol";
import "./lib/MafiaRules.sol";
import "./lib/ERC2771Context.sol";

/// @dev Minimal ERC20 surface the market needs to escrow + pay out wagers in the bet token.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title MafiaMarket — multi-match parimutuel prediction-market factory (one uniform categorical
///        market type — the faction-win market and every side market are the same `Prop`) with fully
///        on-chain, TEE-verified, trust-minimized settlement for AI-Mafia matches.
/// @dev Settlement is trust-MINIMIZED, not trustless. It assumes (a) `teeSigner` is the genuine
///      0G-TEE provider key (the host sets it per match) and (b) the host's committed roles are
///      honest. The contract enforces everything it can on-chain — commit-reveal of roles,
///      canonical role composition, per-move TEE signature + decision binding, and owner-only
///      settlement — so a host cannot reorder/forge/truncate moves, relabel roles, or be
///      front-run on the reveal. A host that sets a `teeSigner` it controls can still fabricate;
///      that residual trust is the product's TEE assumption, not an on-chain guarantee.
/// @dev Gasless-ready: inherits ERC2771Context, so a bettor with zero native 0G can place/claim
///      wagers through the optional gas relayer (the trusted Forwarder relays the call; the relayer
///      pays gas). Only the value-MOVING user functions use `_msgSender()`; owner/treasury functions
///      keep `msg.sender` (the host/treasury always transact directly, never via the relayer).
///      Direct calls are unchanged — `_msgSender() == msg.sender` unless the caller IS the forwarder
///      — so the relayer is purely additive.
contract MafiaMarket is ERC2771Context {
    enum MatchState { None, Created, Locked, Settled, RefundMode }
    /// @dev Side-market ("prop") variety — CATEGORICAL (multi-outcome) parimutuel markets, all resolved
    ///      from the SAME verified run:
    ///      - PlayerFate    — "what happens to seat N?" Bucketed by death round: outcome 0 = survives,
    ///        outcome k = out in round k (1..FATE_BUCKETS-2), and the last bucket (FATE_BUCKETS-1)
    ///        catches death in round >= FATE_BUCKETS-1 ("out in round 4+"). Subsumes the old Survival +
    ///        RoundOfDeath YES/NO markets. FATE_BUCKETS outcomes. NOT FLOATED FOR NOW — createMatch no
    ///        longer mints a per-seat fate market; the kind + settle branch are retained so re-adding it
    ///        is just restoring the seat loop in createMatch.
    ///      - RoundVotedOut — "who is voted out in round R's day vote?" A RECURRING per-round market:
    ///        one market (Prop.param == R) is created up front for round 1 and the host opens a fresh
    ///        one per later round via openVotedOutRound() as the match advances. Outcomes: one per seat
    ///        (0..playerCount-1) plus a final "no one (tie / no elimination)" outcome — playerCount + 1
    ///        in total. Each market settles against THAT round's day-vote elimination.
    ///      - NightKill    — "who falls before dawn in round R's night?" The night-side twin of
    ///        RoundVotedOut: a RECURRING per-round market that opens at nightfall and freezes at dawn, so
    ///        the night's dead zone becomes a betting window. Round 1 is created up front (Prop.param == 1)
    ///        and the host floats later rounds via openNightKillRound(). Outcomes: one per seat plus a
    ///        final "no one (kill blocked / a quiet night)" outcome — playerCount + 1 in total. Each
    ///        market settles against THAT round's NIGHT kill (a seat killed at night, not day-voted).
    ///      - DetectiveClaim — "is seat N, who went public as the Detective, telling the truth or bluffing?"
    ///        A SINGLE per-match binary market (Prop.param == the claiming seat) with exactly two outcomes:
    ///        0 = BLUFF (a fake claim — Mafia/Town), 1 = REAL DETECTIVE. It is NOT created up front: the
    ///        host floats it on demand via openDetectiveClaim() the first time a seat publicly claims the
    ///        Detective role, and it stays open until settle() (roles are hidden until the reveal, so the
    ///        truth can't be shown mid-match). Settles PURELY from the commit-reveal-verified roles
    ///        (g.roles[param] == DETECTIVE), so it adds no new game state and no new trust — a Mafia
    ///        counter-claim only moves money toward BLUFF, it never spawns a second market.
    ///      - MafiaSeat — "who is the Mafia?" A SINGLE per-match categorical market with one outcome per
    ///        seat (numOutcomes == playerCount; Prop.param unused/0). Like DetectiveClaim it is NOT created
    ///        up front — the host floats it once at match start via openMafiaSeatMarket() so it is bettable
    ///        for the whole match, and it stays open until settle() (roles are hidden until the reveal).
    ///        Settles PURELY from the commit-reveal-verified roles: the winning outcome is the seat whose
    ///        role is MAFIA (the lowest-index Mafia seat if a larger composition seats more than one), so
    ///        it adds no new game state and no new trust.
    ///      - Faction — "which faction wins?" The headline market, now a normal 2-outcome prop:
    ///        outcome 0 = TOWN wins, 1 = MAFIA wins (preserving the old YES=Mafia / NO=Town convention).
    ///        Floated ONCE at match start via openFactionMarket() (numOutcomes == 2, Prop.param unused).
    ///        Settles from the verified run: winner = MAFIA(1) if g.mafiaWins else TOWN(0); a MISTRIAL
    ///        (g.over == false — the game hit max rounds with no winner) Voids the market (full refund).
    ///        There is NO separate Draw outcome or draw fee — a mistrial is just a Void like any other prop.
    ///      The enum can grow further with no storage migration.
    enum PropKind { PlayerFate, RoundVotedOut, NightKill, DetectiveClaim, MafiaSeat, Faction }
    /// @dev A market's resolution state. At settle a single `winningOutcome` is chosen (Resolved), or the
    ///      market Voids — when nobody backed the winning outcome, OR (Faction) the game was a mistrial —
    ///      and every stake is refunded. There is no Draw state: a mistrial is just a Void.
    enum PropState { Unset, Resolved, Void }

    struct Move {
        Decision decision;
        bytes rawResponseBody;
        uint256 contentOffset;
        uint256 contentLen;
        string reqHashHex;
        bytes signature;
    }

    struct CreateMatchParams {
        bytes32 roleCommit;
        bytes32 personaPoolRoot;
        address teeSigner;
        string providerType;
        string providerIdentity;
        string tlsFingerprint;
        string nonce;
        uint8 playerCount;
        uint64 bettingOpenBlock;
        uint64 bettingCloseBlock;
        uint64 matchStartBlock;
        uint64 settlementDeadlineBlock;
        uint16 feeBps;
    }

    struct Match {
        MatchState state;
        uint64 bettingOpenBlock;
        uint64 bettingCloseBlock;
        uint64 matchStartBlock; // schedule validation + evidence only; not a post-creation gate (settle gates on bettingCloseBlock/settlementDeadlineBlock).
        uint64 settlementDeadlineBlock;
        bytes32 roleCommit;
        bytes32 entropySeed;
        bytes32 personaPoolRoot;
        address teeSigner;
        string providerType;
        string providerIdentity;
        string tlsFingerprint;
        string nonce;
        uint8 playerCount;
        bytes32 transcriptCID;
        uint16 feeBps;
    }

    /// @notice A per-match CATEGORICAL market resolved from the TEE-verified MafiaRules run — EVERY market
    ///         (the headline Faction market included) is one of these; there is no separate market type.
    ///         Bettors stake on ONE of `numOutcomes` outcomes; at settle exactly one outcome wins (or the
    ///         market Voids) and its backers split the net pot pro-rata. PlayerFate: outcomes are
    ///         death-round buckets of seat `param`. RoundVotedOut: seats + a "no one" for round `param`'s vote.
    struct Prop {
        PropKind kind;
        uint8 param;          // PlayerFate: the seat. RoundVotedOut / NightKill: the 1-based round. DetectiveClaim: the claiming seat. MafiaSeat / Faction: unused (0).
        uint8 numOutcomes;    // PlayerFate: FATE_BUCKETS. RoundVotedOut / NightKill: playerCount + 1. DetectiveClaim: 2 (BLUFF / REAL). MafiaSeat: playerCount. Faction: 2 (TOWN / MAFIA).
        bool closed;          // betting frozen mid-match (the outcome became public); see closeProp(). Payout-neutral.
        PropState state;      // Unset until settle; Resolved (winningOutcome valid) or Void (refund all).
        uint8 winningOutcome; // the outcome that won — valid iff state == Resolved.
        uint128 netPot;       // gross pot (Σ pools) minus fee; split among winningOutcome backers pro-rata.
        uint128 winningPool;  // pools[winningOutcome] — the denominator of the pro-rata split.
        uint128[] pools;      // stake per outcome, length == numOutcomes.
    }

    uint256 public constant MIN_BET = 0.01 ether;
    uint256 public constant MAX_BET_PER_TX = 10_000 ether;
    uint64 public constant MIN_BETTING_WINDOW = 100;
    uint64 public constant LOCK_BUFFER = 5;
    uint64 public constant MIN_MATCH_DURATION = 25;
    uint16 public constant MAX_FEE_BPS = 500;
    /// @notice Number of outcome buckets in a PlayerFate market: outcome 0 = survives, then one bucket
    ///         per death round 1..FATE_BUCKETS-2, and the last bucket (FATE_BUCKETS-1) catches death in
    ///         round >= FATE_BUCKETS-1 ("out in round 4+"). Fixed; the resolver caps deathRound to it.
    uint8 public constant FATE_BUCKETS = 5;

    address public owner;
    address public protocolTreasury;
    /// @notice The ERC20 every wager, payout, refund and fee is denominated in (see MockBetToken).
    ///         All amounts/pools below are token base units (18 decimals), not native 0G.
    IERC20 public immutable betToken;
    uint256 public nextMatchId;
    uint128 public protocolFeeAccrued;

    mapping(uint256 => Match) public matches;

    // Per-match markets ("props"): the headline Faction market + one PlayerFate per seat + the recurring
    // round markets + the on-demand singles. ALL wagers flow through the one categorical path below,
    // keyed matchId => propIdx => user; there is no separate faction stake pair anymore.
    mapping(uint256 => Prop[]) internal _props;
    /// @notice Per-outcome stake: matchId => propIdx => outcome => user => amount. The single stake ledger
    ///         for every market (a categorical market has one pool/stake per outcome).
    mapping(uint256 => mapping(uint256 => mapping(uint8 => mapping(address => uint128)))) public propStake;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public propClaimed;
    /// @notice Highest "voted out" round that has a band of props on this match. createMatch opens
    ///         round 1 (so this starts at 1 once a match exists); openVotedOutRound bumps it as the
    ///         match advances. The per-round VotedOut market re-opens by appending the next band.
    mapping(uint256 => uint8) public votedOutRoundsOpened;
    /// @notice Highest "night kill" round that has a market on this match — the night-side twin of
    ///         votedOutRoundsOpened. createMatch seeds round 1; openNightKillRound bumps it as the
    ///         match advances (a fresh market floated each nightfall).
    mapping(uint256 => uint8) public nightKillRoundsOpened;
    /// @notice Whether this match's single "Detective claim: real or bluff?" market has been floated
    ///         yet (openDetectiveClaim). Unlike the round markets it is NOT seeded at createMatch — a
    ///         claim is an unpredictable speech event — and there is at most ONE per match, so this is a
    ///         plain open-once guard rather than a counter.
    mapping(uint256 => bool) public detectiveClaimOpened;
    /// @notice Whether this match's single "Who is the Mafia?" market has been floated yet
    ///         (openMafiaSeatMarket). Like DetectiveClaim it is NOT seeded at createMatch and there is at
    ///         most ONE per match, so this is a plain open-once guard. The host opens it at match start so
    ///         it is bettable for the whole match.
    mapping(uint256 => bool) public mafiaSeatOpened;
    /// @notice Whether this match's headline "which faction wins?" market has been floated yet
    ///         (openFactionMarket). Like the other singles it is NOT seeded at createMatch; the host opens
    ///         it at match start (mandatory — the match's core market) so it is bettable for the whole match.
    mapping(uint256 => bool) public factionMarketOpened;

    event MatchCreated(
        uint256 indexed matchId, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot,
        address teeSigner, uint8 playerCount,
        uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock
    );
    /// @notice Side markets auto-created with the match: the round-1 RoundVotedOut and round-1 NightKill
    ///         markets, so `count` == 2 at creation. (The per-seat PlayerFate/survival market is not
    ///         floated for now.) Later RoundVotedOut / NightKill rounds are appended on demand (see
    ///         openVotedOutRound / openNightKillRound and their *RoundOpened events).
    event PropsCreated(uint256 indexed matchId, uint256 count);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyTreasury() { require(msg.sender == protocolTreasury, "not treasury"); _; }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @param _trustedForwarder the EIP-2771 Forwarder allowed to relay bet/claim/refund on a
    ///        bettor's behalf (pass address(0) to disable the gas relayer entirely).
    constructor(address _treasury, address _betToken, address _trustedForwarder) ERC2771Context(_trustedForwarder) {
        require(_treasury != address(0), "zero treasury");
        require(_betToken != address(0), "zero token");
        owner = msg.sender;
        protocolTreasury = _treasury;
        betToken = IERC20(_betToken);
    }

    /// @notice Hand the trusted-host role to a new address (e.g. key rotation).
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function createMatch(CreateMatchParams calldata p) external onlyOwner returns (uint256 matchId) {
        require(p.bettingOpenBlock > block.number, "open in past");
        require(p.bettingCloseBlock > p.bettingOpenBlock + MIN_BETTING_WINDOW, "window too short");
        require(p.matchStartBlock >= p.bettingCloseBlock + LOCK_BUFFER, "no lock buffer");
        require(p.settlementDeadlineBlock > p.matchStartBlock + MIN_MATCH_DURATION, "deadline too soon");
        require(p.feeBps <= MAX_FEE_BPS, "fee too high");
        require(p.teeSigner != address(0), "zero signer");
        require(p.roleCommit != bytes32(0), "zero role commit");
        require(p.playerCount >= 5 && p.playerCount <= 7, "bad player count");
        _validateNonce(p.nonce); // printable-ASCII so DecisionCodec's escaping matches JSON.stringify byte-for-byte

        matchId = nextMatchId++;
        Match storage m = matches[matchId];
        m.state = MatchState.Created;
        m.bettingOpenBlock = p.bettingOpenBlock;
        m.bettingCloseBlock = p.bettingCloseBlock;
        m.matchStartBlock = p.matchStartBlock;
        m.settlementDeadlineBlock = p.settlementDeadlineBlock;
        m.roleCommit = p.roleCommit;
        m.entropySeed = keccak256(abi.encodePacked(block.prevrandao, matchId, block.timestamp));
        m.personaPoolRoot = p.personaPoolRoot;
        m.teeSigner = p.teeSigner;
        m.providerType = p.providerType;
        m.providerIdentity = p.providerIdentity;
        m.tlsFingerprint = p.tlsFingerprint;
        m.nonce = p.nonce;
        m.playerCount = p.playerCount;
        m.feeBps = p.feeBps;

        emit MatchCreated(
            matchId, p.roleCommit, m.entropySeed, p.personaPoolRoot, p.teeSigner, p.playerCount,
            p.bettingOpenBlock, p.bettingCloseBlock, p.matchStartBlock, p.settlementDeadlineBlock
        );

        // Auto-create the two RECURRING per-round side markets' round 1, resolved from the same verified
        // run at settle():
        //   props[0]  RoundVotedOut, round 1 (param == 1; playerCount + 1 outcomes)
        //   props[1]  NightKill,     round 1 (param == 1; playerCount + 1 outcomes)
        // so propCount(matchId) == 2 at creation. The per-seat "player fate" (survival) market is REMOVED
        // for now — createMatch no longer mints it. The PropKind.PlayerFate branch + FATE_BUCKETS are kept
        // intact so re-adding it is just restoring a `for (seat..) props.push(PlayerFate)` loop here. Both
        // recurring markets append their later rounds on demand (openVotedOutRound / openNightKillRound),
        // and the on-demand singles (Faction, MafiaSeat, DetectiveClaim) float at the tail, so the kinds
        // interleave — DON'T assume a fixed index formula: the server/UI maps propIdx ⇄ (kind, param) by
        // reading each Prop's fields (kind is the label authority).
        Prop[] storage props = _props[matchId];
        props.push(_newProp(PropKind.RoundVotedOut, 1, p.playerCount + 1));
        props.push(_newProp(PropKind.NightKill, 1, p.playerCount + 1));
        votedOutRoundsOpened[matchId] = 1;  // round-1 "voted out" market created up front
        nightKillRoundsOpened[matchId] = 1; // round-1 "night kill" market created up front
        emit PropsCreated(matchId, props.length);
    }

    /// @dev Construct a fresh, empty categorical prop with a zero-initialized per-outcome pool array.
    function _newProp(PropKind kind, uint8 param, uint8 numOutcomes) private pure returns (Prop memory) {
        return Prop({
            kind: kind, param: param, numOutcomes: numOutcomes, closed: false,
            state: PropState.Unset, winningOutcome: 0, netPot: 0, winningPool: 0,
            pools: new uint128[](numOutcomes)
        });
    }

    /// @dev Sum of every outcome's pool — the gross pot of a categorical prop.
    function _poolSum(uint128[] storage pools) private view returns (uint128 sum) {
        for (uint256 o = 0; o < pools.length; o++) sum += pools[o];
    }

    /// @dev A user's total stake across every outcome of a prop — the refund base on a Void/abandoned prop.
    function _userPropTotal(uint256 matchId, uint256 propIdx, address user, uint8 numOutcomes)
        private view returns (uint256 s)
    {
        for (uint8 o = 0; o < numOutcomes; o++) s += propStake[matchId][propIdx][o][user];
    }

    /// @dev The match nonce is embedded (JSON-string-escaped) inside every signed body and
    ///      re-encoded on-chain by DecisionCodec. DecisionCodec only escapes `"` and `\`, which
    ///      matches JS `JSON.stringify` exactly for printable ASCII (0x20–0x7E). Restricting the
    ///      nonce to that range guarantees the on-chain decision binding cannot silently diverge
    ///      from the engine's encoding (which would otherwise brick settlement → refund mode).
    function _validateNonce(string memory nonce) private pure {
        bytes memory b = bytes(nonce);
        require(b.length > 0, "bad nonce");
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            require(c >= 0x20 && c <= 0x7E, "bad nonce");
        }
    }

    event BettingLocked(uint256 indexed matchId);

    event PropBetPlaced(
        uint256 indexed matchId, uint256 indexed propIdx, address indexed user,
        uint8 outcome, uint128 amount, uint128 newPool
    );

    /// @notice Wager on ANY market by staking on one `outcome` (Faction: 1 = MAFIA wins; PlayerFate:
    ///         outcome 2 = "out in round 2"; RoundVotedOut: outcome == a seat, or the last = "no one").
    ///         This is the single bet entrypoint for every market — headline and side alike. CHIP is pulled
    ///         via approve+transferFrom. `propIdx` indexes the match's props; `outcome` must be < numOutcomes.
    function betProp(uint256 matchId, uint256 propIdx, uint8 outcome, uint128 amount) external {
        Match storage m = matches[matchId];
        // Betting is open from bettingOpenBlock until the match leaves Created (settle/lock) and only while
        // the settlement deadline hasn't lapsed.
        require(m.state == MatchState.Created, "not open");
        require(block.number >= m.bettingOpenBlock, "betting not started");
        require(block.number <= m.settlementDeadlineBlock, "betting closed");
        require(amount >= MIN_BET, "below min bet");
        require(amount <= MAX_BET_PER_TX, "above max bet");
        Prop storage pr = _props[matchId][propIdx]; // reverts on out-of-range propIdx
        // Once a market's outcome is publicly decided (the seat fell / the round's vote is in), the host
        // closes it so nobody can pile onto an already-won outcome for a riskless profit. Closing is
        // payout-neutral (see closeProp), so this is the on-chain enforcement of "no betting a decided market".
        require(!pr.closed, "prop closed");
        require(outcome < pr.numOutcomes, "bad outcome");
        address user = _msgSender(); // EIP-2771: the relayed bettor (== msg.sender on direct calls)
        require(betToken.transferFrom(user, address(this), amount), "token transfer failed");
        pr.pools[outcome] += amount;
        propStake[matchId][propIdx][outcome][user] += amount;
        emit PropBetPlaced(matchId, propIdx, user, outcome, amount, pr.pools[outcome]);
    }

    event PropClosed(uint256 indexed matchId, uint256 indexed propIdx);

    /// @notice Freeze betting on a single side market mid-match (onlyOwner). The host calls this the
    ///         moment a seat's survival outcome becomes publicly decided — i.e. that seat falls — so
    ///         nobody can bet the already-won NO side ("wager on a corpse") for a riskless profit.
    /// @dev    PAYOUT-NEUTRAL by construction: the prop still resolves from the SAME TEE-verified run
    ///         at settle() (closeProp never sets outcome/pools), so closing only refuses *new* stakes.
    ///         It therefore adds no settlement trust — the host can already freeze the whole market
    ///         via lockBetting or withhold settlement — it just moves the existing frontend "dead
    ///         seat → market closed" gate on-chain. Idempotent; only meaningful while betting is open.
    function closeProp(uint256 matchId, uint256 propIdx) external onlyOwner {
        require(matches[matchId].state == MatchState.Created, "not open");
        Prop storage pr = _props[matchId][propIdx]; // reverts on out-of-range propIdx
        if (pr.closed) return; // re-closing is a no-op
        pr.closed = true;
        emit PropClosed(matchId, propIdx);
    }

    event VotedOutRoundOpened(uint256 indexed matchId, uint8 round, uint256 startIdx);

    /// @notice Open the NEXT round's "voted out" market — one RoundVotedOut prop (playerCount + 1
    ///         outcomes), tagged with the new round. This is how the per-round market re-opens: as the
    ///         match advances past each day vote, the host calls this to float a fresh market for the
    ///         upcoming vote. onlyOwner and only while betting is open (state == Created). Sequential by
    ///         construction — it always opens `votedOutRoundsOpened + 1` (createMatch seeds round 1), so
    ///         the markets stay contiguous after the round-1 market at propIdx n + (round - 1).
    /// @dev    Adds NO settlement trust: the new market still resolves from the SAME TEE-verified run at
    ///         settle() (`g.votedOutRound[seat] == round`). It only creates the wagering surface.
    /// @return round   the round the new market targets (1-based).
    /// @return startIdx the propIdx of the new market.
    function openVotedOutRound(uint256 matchId) external onlyOwner returns (uint8 round, uint256 startIdx) {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Created, "not open");
        uint8 prev = votedOutRoundsOpened[matchId];
        require(prev > 0, "no match"); // createMatch sets it to 1; 0 means the match doesn't exist
        round = prev + 1;
        Prop[] storage props = _props[matchId];
        startIdx = props.length;
        props.push(_newProp(PropKind.RoundVotedOut, round, m.playerCount + 1));
        votedOutRoundsOpened[matchId] = round;
        emit VotedOutRoundOpened(matchId, round, startIdx);
    }

    event NightKillRoundOpened(uint256 indexed matchId, uint8 round, uint256 startIdx);

    /// @notice Open the NEXT round's "night kill" market — the night-side twin of openVotedOutRound.
    ///         One NightKill prop (playerCount + 1 outcomes) tagged with the new round. The host calls
    ///         this each nightfall to float a fresh market for the upcoming night; it freezes (closeProp)
    ///         at dawn once the night's kill is public. onlyOwner and only while betting is open. Always
    ///         opens `nightKillRoundsOpened + 1` (createMatch seeds round 1), appended at the array tail.
    /// @dev    Adds NO settlement trust: the new market still resolves from the SAME TEE-verified run at
    ///         settle() (a seat killed at night in `round`). It only creates the wagering surface.
    /// @return round    the round the new market targets (1-based).
    /// @return startIdx the propIdx of the new market.
    function openNightKillRound(uint256 matchId) external onlyOwner returns (uint8 round, uint256 startIdx) {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Created, "not open");
        uint8 prev = nightKillRoundsOpened[matchId];
        require(prev > 0, "no match"); // createMatch sets it to 1; 0 means the match doesn't exist
        round = prev + 1;
        Prop[] storage props = _props[matchId];
        startIdx = props.length;
        props.push(_newProp(PropKind.NightKill, round, m.playerCount + 1));
        nightKillRoundsOpened[matchId] = round;
        emit NightKillRoundOpened(matchId, round, startIdx);
    }

    event DetectiveClaimOpened(uint256 indexed matchId, uint256 startIdx, uint8 seat);

    /// @notice Open the single "Detective claim: real or bluff?" market for `seat` — the seat that just
    ///         went public as the Detective. One binary prop (2 outcomes: 0 = BLUFF, 1 = REAL DETECTIVE)
    ///         tagged with the claiming seat. The host calls this the first time a claim happens; there is
    ///         at most ONE per match (a Mafia counter-claim just moves money toward BLUFF on this same
    ///         pool — see the note in the settle path). onlyOwner and only while betting is open.
    /// @dev    Adds NO settlement trust: it resolves from the SAME commit-reveal-verified roles at
    ///         settle() (`g.roles[seat] == DETECTIVE`). It only creates the wagering surface. Stays open
    ///         until settle — roles are hidden until the reveal, so the truth can't become public
    ///         mid-match to justify a closeProp freeze.
    /// @return startIdx the propIdx of the new market.
    function openDetectiveClaim(uint256 matchId, uint8 seat) external onlyOwner returns (uint256 startIdx) {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Created, "not open");
        require(seat < m.playerCount, "bad seat");
        require(!detectiveClaimOpened[matchId], "already opened");
        Prop[] storage props = _props[matchId];
        startIdx = props.length;
        props.push(_newProp(PropKind.DetectiveClaim, seat, 2));
        detectiveClaimOpened[matchId] = true;
        emit DetectiveClaimOpened(matchId, startIdx, seat);
    }

    event MafiaSeatMarketOpened(uint256 indexed matchId, uint256 startIdx);

    /// @notice Open the single "Who is the Mafia?" market — one categorical prop with one outcome per
    ///         seat (numOutcomes == playerCount, param unused). NOT seeded at createMatch; the host floats
    ///         it once at match start (open-once via mafiaSeatOpened) so it is bettable for the whole match.
    ///         onlyOwner and only while betting is open (state == Created).
    /// @dev    Adds NO settlement trust: it resolves from the SAME commit-reveal-verified roles at settle()
    ///         (the Mafia seat), so it only creates the wagering surface. Stays open until settle — roles
    ///         are hidden until the reveal, so the answer can't become public mid-match to justify a freeze.
    /// @return startIdx the propIdx of the new market.
    function openMafiaSeatMarket(uint256 matchId) external onlyOwner returns (uint256 startIdx) {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Created, "not open");
        require(m.playerCount > 0, "no match");
        require(!mafiaSeatOpened[matchId], "already opened");
        Prop[] storage props = _props[matchId];
        startIdx = props.length;
        props.push(_newProp(PropKind.MafiaSeat, 0, m.playerCount));
        mafiaSeatOpened[matchId] = true;
        emit MafiaSeatMarketOpened(matchId, startIdx);
    }

    event FactionMarketOpened(uint256 indexed matchId, uint256 startIdx);

    /// @notice Open the headline "which faction wins?" market — one binary prop (2 outcomes: 0 = TOWN
    ///         wins, 1 = MAFIA wins), param unused. NOT seeded at createMatch; the host floats it once at
    ///         match start (open-once via factionMarketOpened) so it is bettable the whole match. This is
    ///         the match's core market, so the host treats the open as MANDATORY. onlyOwner and only while
    ///         betting is open (state == Created).
    /// @dev    Resolves from the SAME verified run at settle(): MAFIA(1) if g.mafiaWins else TOWN(0); a
    ///         mistrial (g.over == false) Voids the market (full refund) — there is no draw fee.
    /// @return startIdx the propIdx of the new market.
    function openFactionMarket(uint256 matchId) external onlyOwner returns (uint256 startIdx) {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Created, "not open");
        require(m.playerCount > 0, "no match");
        require(!factionMarketOpened[matchId], "already opened");
        Prop[] storage props = _props[matchId];
        startIdx = props.length;
        props.push(_newProp(PropKind.Faction, 0, 2));
        factionMarketOpened[matchId] = true;
        emit FactionMarketOpened(matchId, startIdx);
    }

    // Optional, owner-only manual close. Betting otherwise stays open until settle(); the host can
    // call this to freeze the pools early (e.g. once the match ends, before submitting settlement).
    // onlyOwner so no third party can close betting ahead of the host (which would break the
    // "open until settled" guarantee). settle()/enterRefundMode() also accept Created, so this is optional.
    function lockBetting(uint256 matchId) external onlyOwner {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Created, "not lockable");
        require(block.number >= m.bettingCloseBlock, "betting still open");
        m.state = MatchState.Locked;
        emit BettingLocked(matchId);
    }

    event MatchSettled(uint256 indexed matchId, bytes32 transcriptCID);

    /// @dev onlyOwner: the host is the only party that holds the reveal (salt) until it
    ///      broadcasts, so permissionless settlement added no liveness — it only opened a
    ///      mempool front-run where anyone could copy the revealed salt and submit a *truncated*
    ///      move list to force a Draw, denying the rightful winners. Owner-only closes that; the
    ///      liveness fallback if the host never settles is enterRefundMode/refund after the deadline.
    function settle(
        uint256 matchId,
        Move[] calldata moves,
        Role[] calldata revealedRoles,
        bytes32 salt,
        bytes32 transcriptCID
    ) external onlyOwner {
        Match storage m = matches[matchId];
        // Betting stays open until this settle() lands (it flips state to Settled, ending bets). The
        // host may settle as soon as the match resolves — there is no minimum betting-window wait.
        require(m.state == MatchState.Created || m.state == MatchState.Locked, "not settleable");
        require(block.number <= m.settlementDeadlineBlock, "deadline passed");

        _checkRoleReveal(m, revealedRoles, salt);

        // 2. Verify each move's TEE envelope + bind its decision, then run the rules engine.
        MafiaRules.Game memory g = _verifyAndApply(m, moves, revealedRoles);

        // Resolve EVERY market (the headline Faction market included) from the SAME verified final state,
        // then finalize the match — no extra trust, no extra tx.
        _settleProps(matchId, m, g);
        _writeResult(matchId, m, transcriptCID);
    }

    event PropSettled(uint256 indexed matchId, uint256 indexed propIdx, PropState state, uint8 winningOutcome, uint128 netPot);

    /// @dev Resolve each categorical side market from the already-verified final game state `g`.
    ///      PlayerFate: the winning outcome is the seat's death-round bucket — 0 if it survived
    ///      (g.deathRound == 0), else min(deathRound, FATE_BUCKETS-1) so round >= the last bucket falls
    ///      in it. RoundVotedOut: the winning outcome is the seat eliminated by THIS market's round day
    ///      vote (g.votedOutRound[seat] == param); if that round took no one (a tie, or the match ended
    ///      before the vote) the last outcome ("no one") wins. votedOutRound is 1-based (0 = never
    ///      day-voted) and param >= 1, so the equality skips un-voted seats without a sentinel check.
    ///      NightKill: the winning outcome is the seat killed at NIGHT in THIS market's round — died that
    ///      round (g.deathRound[seat] == param) but was NOT the day vote's casualty (g.votedOutRound[seat]
    ///      == 0, which stays 0 for a night kill); a blocked kill / quiet night leaves the "no one"
    ///      outcome. No new game state is needed — a night death is exactly a round death that wasn't a
    ///      vote-out. At most one seat falls per night, so the first match is unambiguous.
    ///      Faction: the winning outcome is MAFIA(1) if g.mafiaWins else TOWN(0); a mistrial (g.over ==
    ///      false) forces Void (no winning faction). An empty winning pool → Void (full refund of every
    ///      outcome). Winners pay the match's standard feeBps; Void is fee-free. Markets never Draw — each
    ///      outcome is unambiguous from the verified run (a mistrial is just a Void).
    function _settleProps(uint256 matchId, Match storage m, MafiaRules.Game memory g) private {
        Prop[] storage props = _props[matchId];
        uint16 feeBps = m.feeBps;
        for (uint256 i = 0; i < props.length; i++) {
            Prop storage pr = props[i];
            uint8 win;
            bool voidIt; // force Void regardless of pools (a mistrial has no winning outcome)
            if (pr.kind == PropKind.PlayerFate) {
                uint8 dr = g.deathRound[pr.param];
                uint8 last = FATE_BUCKETS - 1;
                win = dr >= last ? last : dr; // 0 survives; 1..last-1 the death round; last = round >= last
            } else if (pr.kind == PropKind.RoundVotedOut) {
                // RoundVotedOut: outcomes 0..seats-1 are the seats, the last (== seats) is "no one".
                uint8 seats = pr.numOutcomes - 1;
                win = seats; // default "no one"; overwritten if a seat fell to this round's vote
                for (uint8 seat = 0; seat < seats; seat++) {
                    if (g.votedOutRound[seat] == pr.param) { win = seat; break; }
                }
            } else if (pr.kind == PropKind.NightKill) {
                // NightKill: outcomes 0..seats-1 are the seats, the last (== seats) is "no one". The
                // winner is the seat killed at night in `param` — a death that round that was NOT a
                // day vote-out (votedOutRound stays 0 for a night kill).
                uint8 seats = pr.numOutcomes - 1;
                win = seats; // default "no one" (kill blocked / a quiet night)
                for (uint8 seat = 0; seat < seats; seat++) {
                    if (g.deathRound[seat] == pr.param && g.votedOutRound[seat] == 0) { win = seat; break; }
                }
            } else if (pr.kind == PropKind.DetectiveClaim) {
                // DetectiveClaim: binary. outcome 1 (REAL) wins iff the claiming seat's verified role is
                // DETECTIVE, else outcome 0 (BLUFF). A Mafia counter-claim never opened a second market,
                // so it can only ever tilt this one toward BLUFF; the truth is the role check, nothing else.
                win = g.roles[pr.param] == Role.DETECTIVE ? 1 : 0;
            } else if (pr.kind == PropKind.MafiaSeat) {
                // MafiaSeat: "who is the Mafia?" — outcomes 0..playerCount-1 are the seats. The winning
                // outcome is the seat whose verified role is MAFIA; the lowest-index Mafia seat wins if a
                // larger composition seats more than one. Resolves purely from the commit-reveal-verified
                // roles (composition guarantees at least one Mafia, so the loop always finds a winner).
                win = 0;
                for (uint8 seat = 0; seat < pr.numOutcomes; seat++) {
                    if (g.roles[seat] == Role.MAFIA) { win = seat; break; }
                }
            } else {
                // Faction: the headline market. outcome 1 = MAFIA wins, 0 = TOWN wins. A mistrial
                // (g.over == false — the game hit max rounds with no winner) has no winning faction, so
                // the market Voids (full refund); otherwise it resolves to the winning faction.
                if (!g.over) { voidIt = true; }
                win = g.mafiaWins ? 1 : 0;
            }
            uint128 winPool = pr.pools[win];
            uint128 gross = _poolSum(pr.pools);
            PropState st = (winPool == 0 || voidIt) ? PropState.Void : PropState.Resolved;
            uint128 fee = st == PropState.Void ? 0 : uint128((uint256(gross) * feeBps) / 10000);
            pr.state = st;
            pr.winningOutcome = win;
            pr.winningPool = winPool;
            pr.netPot = gross - fee;
            protocolFeeAccrued += fee;
            emit PropSettled(matchId, i, st, win, pr.netPot);
        }
    }

    function _checkRoleReveal(Match storage m, Role[] calldata revealedRoles, bytes32 salt) private view {
        // 1. Commit-reveal: sha256(roleBytes ++ salt) == roleCommit (precompile 0x2).
        require(revealedRoles.length == m.playerCount, "roles length");
        bytes memory roleBytes = new bytes(revealedRoles.length);
        for (uint256 i = 0; i < revealedRoles.length; i++) {
            roleBytes[i] = bytes1(uint8(revealedRoles[i]));
        }
        require(sha256(bytes.concat(roleBytes, salt)) == m.roleCommit, "role reveal mismatch");
        // 2. Canonical composition (engine COMPOSITION): the commit binds these roles, but the
        //    host chose the commit — so also pin the role MULTISET. Otherwise a host could commit
        //    a set that relabels TOWN seats as MAFIA (their day-votes stay legal) to inflate the
        //    mafia count and flip computeWinner. With this, the revealed roles must be exactly the
        //    seat counts the engine assigns for this playerCount.
        _checkComposition(m.playerCount, revealedRoles);
    }

    /// @dev 5p: 1/1/1/2, 6p: 1/1/1/3, 7p: 2/1/1/3 (MAFIA/DOCTOR/DETECTIVE/TOWN).
    function _checkComposition(uint8 playerCount, Role[] calldata roles) private pure {
        uint256 mafia;
        uint256 doctor;
        uint256 detective;
        uint256 town;
        for (uint256 i = 0; i < roles.length; i++) {
            Role r = roles[i];
            if (r == Role.MAFIA) mafia++;
            else if (r == Role.DOCTOR) doctor++;
            else if (r == Role.DETECTIVE) detective++;
            else town++;
        }
        uint256 expMafia = playerCount == 7 ? 2 : 1;
        require(
            mafia == expMafia && doctor == 1 && detective == 1 && town == uint256(playerCount) - expMafia - 2,
            "bad composition"
        );
    }

    // Finalize the match: record the transcript pointer and flip to Settled. The faction result and every
    // market's payout are resolved by _settleProps (called right after) from the SAME verified run — there
    // is no longer a bespoke faction settlement here.
    function _writeResult(uint256 matchId, Match storage m, bytes32 transcriptCID) private {
        m.transcriptCID = transcriptCID;
        m.state = MatchState.Settled;
        emit MatchSettled(matchId, transcriptCID);
    }

    /// @dev Verification context cached from storage once to avoid repeated SLOAD in the loop.
    struct VerifyCtx {
        address teeSigner;
        string providerType;
        string providerIdentity;
        string tlsFingerprint;
        string nonce;
    }

    function _verifyAndApply(
        Match storage m,
        Move[] calldata moves,
        Role[] calldata revealedRoles
    ) private view returns (MafiaRules.Game memory g) {
        // Cache string fields from storage once to reduce SLOAD pressure in the loop.
        VerifyCtx memory ctx;
        ctx.teeSigner      = m.teeSigner;
        ctx.providerType   = m.providerType;
        ctx.providerIdentity = m.providerIdentity;
        ctx.tlsFingerprint = m.tlsFingerprint;
        ctx.nonce          = m.nonce;

        Role[] memory roles = _toMemoryRoles(revealedRoles);
        g = MafiaRules.init(roles);
        for (uint256 i = 0; i < moves.length; i++) {
            _verifyMove(ctx, moves[i]);
            MafiaRules.applyDecision(g, moves[i].decision); // reverts on illegal/out-of-order
        }
    }

    function _verifyMove(VerifyCtx memory ctx, Move calldata mv) private pure {
        _checkTee(ctx, mv);
        _checkDecision(ctx.nonce, mv);
    }

    function _checkTee(VerifyCtx memory ctx, Move calldata mv) private pure {
        address signer = TeeEnvelope.recover(
            mv.rawResponseBody, mv.reqHashHex, ctx.providerType, ctx.providerIdentity, ctx.tlsFingerprint, mv.signature
        );
        require(signer == ctx.teeSigner, "bad TEE signature");
    }

    function _checkDecision(string memory nonce, Move calldata mv) private pure {
        string memory expected = DecisionCodec.jsonEscape(DecisionCodec.encode(nonce, mv.decision));
        require(_sliceEquals(mv.rawResponseBody, mv.contentOffset, mv.contentLen, bytes(expected)), "decision not bound to body");
    }

    function _toMemoryRoles(Role[] calldata r) private pure returns (Role[] memory out) {
        out = new Role[](r.length);
        for (uint256 i = 0; i < r.length; i++) out[i] = r[i];
    }

    function _sliceEquals(bytes calldata body, uint256 offset, uint256 len, bytes memory expected) private pure returns (bool) {
        if (offset + len > body.length) return false;
        if (len != expected.length) return false;
        return keccak256(body[offset:offset + len]) == keccak256(expected);
    }

    event RefundModeEntered(uint256 indexed matchId);

    // Flip an abandoned match (host never settled by the deadline) to RefundMode, after which every
    // bettor reclaims their stake per market via refundProp() — there is no bespoke faction refund.
    function enterRefundMode(uint256 matchId) external {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Created || m.state == MatchState.Locked, "not refundable");
        require(block.number > m.settlementDeadlineBlock, "deadline not passed");
        m.state = MatchState.RefundMode;
        emit RefundModeEntered(matchId);
    }

    function withdrawProtocolFees() external onlyTreasury {
        uint128 amt = protocolFeeAccrued;
        require(amt > 0, "nothing to withdraw");
        protocolFeeAccrued = 0;
        require(betToken.transfer(protocolTreasury, amt), "transfer failed");
    }

    event PropClaimed(uint256 indexed matchId, uint256 indexed propIdx, address indexed user, uint256 payout);

    /// @notice Claim a side-market payout from a SETTLED match. Mirrors claim(): Resolved pays the
    ///         winning outcome's backers pro-rata of the net pot; Void returns the full stake (summed
    ///         across every outcome the caller backed).
    function claimProp(uint256 matchId, uint256 propIdx) external {
        require(matches[matchId].state == MatchState.Settled, "not settled");
        address user = _msgSender(); // EIP-2771: the relayed bettor (== msg.sender on direct calls)
        require(!propClaimed[matchId][propIdx][user], "already claimed");
        Prop storage pr = _props[matchId][propIdx];

        uint256 payout;
        if (pr.state == PropState.Resolved) {
            uint256 s = propStake[matchId][propIdx][pr.winningOutcome][user];
            require(s > 0, "no winning stake");
            payout = (uint256(pr.netPot) * s) / pr.winningPool;
        } else if (pr.state == PropState.Void) {
            uint256 s = _userPropTotal(matchId, propIdx, user, pr.numOutcomes);
            require(s > 0, "no stake");
            payout = s;
        } else {
            revert("unexpected outcome");
        }

        propClaimed[matchId][propIdx][user] = true;
        require(betToken.transfer(user, payout), "transfer failed");
        emit PropClaimed(matchId, propIdx, user, payout);
    }

    event PropRefunded(uint256 indexed matchId, uint256 indexed propIdx, address indexed user, uint256 payout);

    /// @notice Reclaim a side-market stake when the match was abandoned (RefundMode). Mirrors refund() —
    ///         returns the caller's total stake across every outcome of the prop.
    function refundProp(uint256 matchId, uint256 propIdx) external {
        require(matches[matchId].state == MatchState.RefundMode, "not refund mode");
        address user = _msgSender(); // EIP-2771: the relayed bettor (== msg.sender on direct calls)
        require(!propClaimed[matchId][propIdx][user], "already refunded");
        Prop storage pr = _props[matchId][propIdx];
        uint256 s = _userPropTotal(matchId, propIdx, user, pr.numOutcomes);
        require(s > 0, "no stake");
        propClaimed[matchId][propIdx][user] = true;
        require(betToken.transfer(user, s), "transfer failed");
        emit PropRefunded(matchId, propIdx, user, s);
    }

    event BatchClaimed(uint256 indexed matchId, address indexed user, uint256 marketsPaid, uint256 total);

    /// @notice Claim EVERY listed side-market payout from a SETTLED match in a single tx — the one-tap
    ///         "collect my winnings" primitive. Semantics match claimProp() per index (Resolved pays the
    ///         winning outcome pro-rata; Void returns the stake), but instead of reverting on an index the
    ///         caller can't collect (out of range, already claimed, or a losing bet) it SKIPS it and moves
    ///         on. That lets a client pass its whole believed-winning set without a stale index or a
    ///         mid-flight double-claim aborting the batch. Duplicated indices are paid once (the first pass
    ///         marks them claimed). Reverts only if nothing at all was collectable. Payouts are summed into
    ///         a single token transfer; a PropClaimed event still fires per collected market.
    function batchClaim(uint256 matchId, uint256[] calldata propIdxs) external {
        require(matches[matchId].state == MatchState.Settled, "not settled");
        address user = _msgSender(); // EIP-2771: the relayed bettor (== msg.sender on direct calls)
        uint256 len = _props[matchId].length;
        uint256 total;
        uint256 paid;
        for (uint256 k = 0; k < propIdxs.length; k++) {
            uint256 propIdx = propIdxs[k];
            if (propIdx >= len) continue;                       // stale/garbage index
            if (propClaimed[matchId][propIdx][user]) continue;  // already collected (or a dup earlier in this batch)
            Prop storage pr = _props[matchId][propIdx];

            uint256 payout;
            if (pr.state == PropState.Resolved) {
                uint256 s = propStake[matchId][propIdx][pr.winningOutcome][user];
                if (s == 0) continue;                            // backed a losing outcome — nothing here
                payout = (uint256(pr.netPot) * s) / pr.winningPool;
            } else if (pr.state == PropState.Void) {
                uint256 s = _userPropTotal(matchId, propIdx, user, pr.numOutcomes);
                if (s == 0) continue;
                payout = s;
            } else {
                continue;                                        // Unset (never settled) — skip
            }

            propClaimed[matchId][propIdx][user] = true;
            total += payout;
            paid++;
            emit PropClaimed(matchId, propIdx, user, payout);
        }
        require(total > 0, "nothing to claim");
        require(betToken.transfer(user, total), "transfer failed");
        emit BatchClaimed(matchId, user, paid, total);
    }

    /// @notice Reclaim EVERY listed side-market stake from an abandoned (RefundMode) match in one tx —
    ///         the batch mirror of refundProp(), with the same skip-don't-revert semantics as batchClaim().
    function batchRefund(uint256 matchId, uint256[] calldata propIdxs) external {
        require(matches[matchId].state == MatchState.RefundMode, "not refund mode");
        address user = _msgSender(); // EIP-2771: the relayed bettor (== msg.sender on direct calls)
        uint256 len = _props[matchId].length;
        uint256 total;
        uint256 paid;
        for (uint256 k = 0; k < propIdxs.length; k++) {
            uint256 propIdx = propIdxs[k];
            if (propIdx >= len) continue;
            if (propClaimed[matchId][propIdx][user]) continue;
            Prop storage pr = _props[matchId][propIdx];
            uint256 s = _userPropTotal(matchId, propIdx, user, pr.numOutcomes);
            if (s == 0) continue;
            propClaimed[matchId][propIdx][user] = true;
            total += s;
            paid++;
            emit PropRefunded(matchId, propIdx, user, s);
        }
        require(total > 0, "nothing to refund");
        require(betToken.transfer(user, total), "transfer failed");
        emit BatchClaimed(matchId, user, paid, total);
    }

    /// @notice Number of side markets attached to a match (one RoundVotedOut per opened round + one
    ///         NightKill per opened round + the on-demand singles — i.e. votedOutRoundsOpened +
    ///         nightKillRoundsOpened + any floated Faction / MafiaSeat / DetectiveClaim market).
    function propCount(uint256 matchId) external view returns (uint256) {
        return _props[matchId].length;
    }

    /// @notice Read one side market's full state (kind, param, per-outcome pools, settled outcome).
    function getProp(uint256 matchId, uint256 propIdx) external view returns (Prop memory) {
        return _props[matchId][propIdx];
    }
}
