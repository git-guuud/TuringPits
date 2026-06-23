// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MafiaTypes.sol";
import "./lib/DecisionCodec.sol";
import "./lib/TeeEnvelope.sol";
import "./lib/MafiaRules.sol";

/// @dev Minimal ERC20 surface the market needs to escrow + pay out wagers in the bet token.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title MafiaMarket — multi-match parimutuel YES/NO faction-win market factory with
///        fully on-chain, TEE-verified, trust-minimized settlement for AI-Mafia matches.
/// @dev Settlement is trust-MINIMIZED, not trustless. It assumes (a) `teeSigner` is the genuine
///      0G-TEE provider key (the host sets it per match) and (b) the host's committed roles are
///      honest. The contract enforces everything it can on-chain — commit-reveal of roles,
///      canonical role composition, per-move TEE signature + decision binding, and owner-only
///      settlement — so a host cannot reorder/forge/truncate moves, relabel roles, or be
///      front-run on the reveal. A host that sets a `teeSigner` it controls can still fabricate;
///      that residual trust is the product's TEE assumption, not an on-chain guarantee.
contract MafiaMarket {
    enum MatchState { None, Created, Locked, Settled, RefundMode }
    enum Outcome { Unset, Yes, No, Draw, Void }
    /// @dev Side-market ("prop") variety. Only Survival ships now; the enum leaves room for
    ///      round-of-death / voted-out-next to slot in later with no storage migration.
    enum PropKind { Survival }

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
        uint16 feeBpsDraw;
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
        uint128 poolYes;
        uint128 poolNo;
        Outcome outcome;
        uint128 netPot;
        uint128 winningPool;
        bytes32 transcriptCID;
        uint16 feeBps;
        uint16 feeBpsDraw;
    }

    /// @notice A per-match side market resolved from the SAME TEE-verified MafiaRules run as the
    ///         faction-win market — no new trust assumption. Survival: YES = "seat `param` is still
    ///         alive when the transcript ends". Parimutuel, exactly like the main YES/NO market.
    struct Prop {
        PropKind kind;
        uint8 param;        // Survival: the seat this market is about (index == seat)
        bool closed;        // betting frozen mid-match (e.g. the seat fell); see closeProp(). Payout-neutral.
        uint128 poolYes;    // YES backers ("survives")
        uint128 poolNo;     // NO backers ("falls")
        Outcome outcome;    // Unset until settle; Yes/No/Void (Survival never Draws)
        uint128 netPot;
        uint128 winningPool;
    }

    uint256 public constant MIN_BET = 0.01 ether;
    uint256 public constant MAX_BET_PER_TX = 10_000 ether;
    uint64 public constant MIN_BETTING_WINDOW = 100;
    uint64 public constant LOCK_BUFFER = 5;
    uint64 public constant MIN_MATCH_DURATION = 25;
    uint16 public constant MAX_FEE_BPS = 500;

    address public owner;
    address public protocolTreasury;
    /// @notice The ERC20 every wager, payout, refund and fee is denominated in (see MockBetToken).
    ///         All amounts/pools below are token base units (18 decimals), not native 0G.
    IERC20 public immutable betToken;
    uint256 public nextMatchId;
    uint128 public protocolFeeAccrued;

    mapping(uint256 => Match) public matches;
    mapping(uint256 => mapping(address => uint128)) public stakeYes;
    mapping(uint256 => mapping(address => uint128)) public stakeNo;
    mapping(uint256 => mapping(address => bool)) public claimed;

    // Per-match side markets ("props"), e.g. one Survival market per seat. Created alongside the
    // match and settled from the same verified run; keyed matchId => propIdx => user.
    mapping(uint256 => Prop[]) internal _props;
    mapping(uint256 => mapping(uint256 => mapping(address => uint128))) public propStakeYes;
    mapping(uint256 => mapping(uint256 => mapping(address => uint128))) public propStakeNo;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public propClaimed;

    event MatchCreated(
        uint256 indexed matchId, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot,
        address teeSigner, uint8 playerCount,
        uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock
    );
    /// @notice One Survival side market per seat is auto-created with the match; `count` == playerCount.
    event PropsCreated(uint256 indexed matchId, uint256 count);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyTreasury() { require(msg.sender == protocolTreasury, "not treasury"); _; }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address _treasury, address _betToken) {
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
        require(p.feeBpsDraw <= p.feeBps, "draw fee > fee");
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
        m.feeBpsDraw = p.feeBpsDraw;

        emit MatchCreated(
            matchId, p.roleCommit, m.entropySeed, p.personaPoolRoot, p.teeSigner, p.playerCount,
            p.bettingOpenBlock, p.bettingCloseBlock, p.matchStartBlock, p.settlementDeadlineBlock
        );

        // Auto-create one Survival side market per seat (propIdx == seat == param). Each resolves
        // from the same verified run at settle(), so propCount(matchId) == playerCount.
        Prop[] storage props = _props[matchId];
        for (uint8 seat = 0; seat < p.playerCount; seat++) {
            props.push(Prop({
                kind: PropKind.Survival, param: seat, closed: false,
                poolYes: 0, poolNo: 0, outcome: Outcome.Unset, netPot: 0, winningPool: 0
            }));
        }
        emit PropsCreated(matchId, p.playerCount);
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

    event BetPlaced(uint256 indexed matchId, address indexed user, bool isYes, uint128 amount, uint128 newPoolYes, uint128 newPoolNo);
    event BettingLocked(uint256 indexed matchId, uint128 finalPoolYes, uint128 finalPoolNo);

    // Bets are denominated in the bet token (CHIP). The bettor must `approve` this contract for at
    // least `amount` first; the wager is pulled via transferFrom (the ERC20 analog of the old
    // payable msg.value). `amount` is token base units (<= MAX_BET_PER_TX << 2^128).
    function betYes(uint256 matchId, uint128 amount) external { _bet(matchId, true, amount); }
    function betNo(uint256 matchId, uint128 amount) external { _bet(matchId, false, amount); }

    function _bet(uint256 matchId, bool isYes, uint128 amount) private {
        Match storage m = matches[matchId];
        // Betting stays OPEN until the match is settled (state leaves Created) — there is no early
        // block-based close. The only bounds are: betting has opened, the match isn't already
        // settled/locked/refunding, and the settlement deadline hasn't lapsed (past it the match is
        // refund-eligible, so new stakes are refused).
        require(m.state == MatchState.Created, "not open");
        require(block.number >= m.bettingOpenBlock, "betting not started");
        require(block.number <= m.settlementDeadlineBlock, "betting closed");
        require(amount >= MIN_BET, "below min bet");
        require(amount <= MAX_BET_PER_TX, "above max bet");
        // Pull the stake into escrow; reverts (no state change) on insufficient balance/allowance.
        require(betToken.transferFrom(msg.sender, address(this), amount), "token transfer failed");
        if (isYes) {
            m.poolYes += amount;
            stakeYes[matchId][msg.sender] += amount;
        } else {
            m.poolNo += amount;
            stakeNo[matchId][msg.sender] += amount;
        }
        emit BetPlaced(matchId, msg.sender, isYes, amount, m.poolYes, m.poolNo);
    }

    event PropBetPlaced(
        uint256 indexed matchId, uint256 indexed propIdx, address indexed user,
        bool isYes, uint128 amount, uint128 newPoolYes, uint128 newPoolNo
    );

    // Wager on a side market (e.g. "does seat N survive?"). Same CHIP approve+transferFrom flow and
    // open window as the main market. `propIdx` indexes the match's props (Survival: propIdx == seat).
    function betPropYes(uint256 matchId, uint256 propIdx, uint128 amount) external { _betProp(matchId, propIdx, true, amount); }
    function betPropNo(uint256 matchId, uint256 propIdx, uint128 amount) external { _betProp(matchId, propIdx, false, amount); }

    function _betProp(uint256 matchId, uint256 propIdx, bool isYes, uint128 amount) private {
        Match storage m = matches[matchId];
        // Identical window to the faction-win market: open from bettingOpenBlock until the match
        // leaves Created (settle/lock) and only while the settlement deadline hasn't lapsed.
        require(m.state == MatchState.Created, "not open");
        require(block.number >= m.bettingOpenBlock, "betting not started");
        require(block.number <= m.settlementDeadlineBlock, "betting closed");
        require(amount >= MIN_BET, "below min bet");
        require(amount <= MAX_BET_PER_TX, "above max bet");
        Prop storage pr = _props[matchId][propIdx]; // reverts on out-of-range propIdx
        // Once a seat's survival is publicly decided (it fell), the host closes its market so nobody
        // can pile onto the already-won NO side for a riskless profit. Closing is payout-neutral
        // (see closeProp), so this is the on-chain enforcement of "no betting a corpse".
        require(!pr.closed, "prop closed");
        require(betToken.transferFrom(msg.sender, address(this), amount), "token transfer failed");
        if (isYes) {
            pr.poolYes += amount;
            propStakeYes[matchId][propIdx][msg.sender] += amount;
        } else {
            pr.poolNo += amount;
            propStakeNo[matchId][propIdx][msg.sender] += amount;
        }
        emit PropBetPlaced(matchId, propIdx, msg.sender, isYes, amount, pr.poolYes, pr.poolNo);
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

    // Optional, owner-only manual close. Betting otherwise stays open until settle(); the host can
    // call this to freeze the pools early (e.g. once the match ends, before submitting settlement).
    // onlyOwner so no third party can close betting ahead of the host (which would break the
    // "open until settled" guarantee). settle()/enterRefundMode() also accept Created, so this is optional.
    function lockBetting(uint256 matchId) external onlyOwner {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Created, "not lockable");
        require(block.number >= m.bettingCloseBlock, "betting still open");
        m.state = MatchState.Locked;
        emit BettingLocked(matchId, m.poolYes, m.poolNo);
    }

    event MatchSettled(uint256 indexed matchId, Outcome outcome, uint128 netPot, bytes32 transcriptCID);

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

        _writeResult(matchId, m, g, transcriptCID);
        // 3. Resolve every side market from the SAME verified final state — no extra trust, no extra tx.
        _settleProps(matchId, m, g);
    }

    event PropSettled(uint256 indexed matchId, uint256 indexed propIdx, Outcome outcome, uint128 netPot);

    /// @dev Resolve each side market from the already-verified final game state `g`. Survival: YES
    ///      wins iff the seat is alive when the transcript ends (`g.alive[param]`). An empty winning
    ///      pool → Void (full refund of both sides). Winners pay the match's standard feeBps; Void is
    ///      fee-free. Survival never Draws — a seat is unambiguously alive or dead at the end.
    function _settleProps(uint256 matchId, Match storage m, MafiaRules.Game memory g) private {
        Prop[] storage props = _props[matchId];
        uint16 feeBps = m.feeBps;
        for (uint256 i = 0; i < props.length; i++) {
            Prop storage pr = props[i];
            bool yesWins;
            if (pr.kind == PropKind.Survival) {
                yesWins = g.alive[pr.param];
            }
            uint128 winPool = yesWins ? pr.poolYes : pr.poolNo;
            Outcome o = winPool == 0 ? Outcome.Void : (yesWins ? Outcome.Yes : Outcome.No);
            uint128 gross = pr.poolYes + pr.poolNo;
            uint128 fee = o == Outcome.Void ? 0 : uint128((uint256(gross) * feeBps) / 10000);
            pr.outcome = o;
            pr.winningPool = winPool;
            pr.netPot = gross - fee;
            protocolFeeAccrued += fee;
            emit PropSettled(matchId, i, o, pr.netPot);
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

    function _writeResult(uint256 matchId, Match storage m, MafiaRules.Game memory g, bytes32 transcriptCID) private {
        // 3. Resolve outcome: unresolved -> Draw; resolved but empty winning pool -> Void.
        Outcome outcome;
        uint128 winningPool;
        if (!g.over) {
            outcome = Outcome.Draw;
        } else if (g.mafiaWins) {
            winningPool = m.poolYes;
            outcome = winningPool == 0 ? Outcome.Void : Outcome.Yes;
        } else {
            winningPool = m.poolNo;
            outcome = winningPool == 0 ? Outcome.Void : Outcome.No;
        }

        // 4. Fees + net pot.
        // If total stake ever exceeded uint128 (≈3.4e20 ether, economically unreachable), this checked add would revert settle — funds remain recoverable via enterRefundMode/refund after the deadline (never trapped).
        uint128 gross = m.poolYes + m.poolNo;
        uint128 fee;
        if (outcome == Outcome.Yes || outcome == Outcome.No) {
            fee = uint128((uint256(gross) * m.feeBps) / 10000);
        } else if (outcome == Outcome.Draw) {
            fee = uint128((uint256(gross) * m.feeBpsDraw) / 10000);
        } // Void: fee stays 0

        m.outcome = outcome;
        m.winningPool = winningPool;
        // netPot is the pre-distribution figure (gross - fee). For Yes/No it is distributed
        // pro-rata; for Draw the actual sum paid is marginally lower because each bettor's refund
        // is floored independently (the remainder stays as wei-dust). Never an over-payment.
        m.netPot = gross - fee;
        m.transcriptCID = transcriptCID;
        protocolFeeAccrued += fee;
        m.state = MatchState.Settled;

        emit MatchSettled(matchId, outcome, m.netPot, transcriptCID);
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
    event Refunded(uint256 indexed matchId, address indexed user, uint256 payout);

    function enterRefundMode(uint256 matchId) external {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Created || m.state == MatchState.Locked, "not refundable");
        require(block.number > m.settlementDeadlineBlock, "deadline not passed");
        m.state = MatchState.RefundMode;
        emit RefundModeEntered(matchId);
    }

    function refund(uint256 matchId) external {
        Match storage m = matches[matchId];
        require(m.state == MatchState.RefundMode, "not refund mode");
        require(!claimed[matchId][msg.sender], "already refunded");
        uint256 s = uint256(stakeYes[matchId][msg.sender]) + stakeNo[matchId][msg.sender];
        require(s > 0, "no stake");
        claimed[matchId][msg.sender] = true;
        require(betToken.transfer(msg.sender, s), "transfer failed");
        emit Refunded(matchId, msg.sender, s);
    }

    function withdrawProtocolFees() external onlyTreasury {
        uint128 amt = protocolFeeAccrued;
        require(amt > 0, "nothing to withdraw");
        protocolFeeAccrued = 0;
        require(betToken.transfer(protocolTreasury, amt), "transfer failed");
    }

    event Claimed(uint256 indexed matchId, address indexed user, uint256 payout);

    function claim(uint256 matchId) external {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Settled, "not settled");
        require(!claimed[matchId][msg.sender], "already claimed");

        uint256 payout;
        Outcome o = m.outcome;
        if (o == Outcome.Yes) {
            uint256 s = stakeYes[matchId][msg.sender];
            require(s > 0, "no winning stake");
            payout = (uint256(m.netPot) * s) / m.winningPool;
        } else if (o == Outcome.No) {
            uint256 s = stakeNo[matchId][msg.sender];
            require(s > 0, "no winning stake");
            payout = (uint256(m.netPot) * s) / m.winningPool;
        } else if (o == Outcome.Draw) {
            uint256 s = uint256(stakeYes[matchId][msg.sender]) + stakeNo[matchId][msg.sender];
            require(s > 0, "no stake");
            payout = (s * (10000 - m.feeBpsDraw)) / 10000;
        } else if (o == Outcome.Void) {
            uint256 s = uint256(stakeYes[matchId][msg.sender]) + stakeNo[matchId][msg.sender];
            require(s > 0, "no stake");
            payout = s;
        } else {
            revert("unexpected outcome");
        }

        claimed[matchId][msg.sender] = true;
        require(betToken.transfer(msg.sender, payout), "transfer failed");
        emit Claimed(matchId, msg.sender, payout);
    }

    event PropClaimed(uint256 indexed matchId, uint256 indexed propIdx, address indexed user, uint256 payout);

    /// @notice Claim a side-market payout from a SETTLED match. Mirrors claim(): Yes/No pay the
    ///         winning side pro-rata of the net pot; Void returns the full stake.
    function claimProp(uint256 matchId, uint256 propIdx) external {
        require(matches[matchId].state == MatchState.Settled, "not settled");
        require(!propClaimed[matchId][propIdx][msg.sender], "already claimed");
        Prop storage pr = _props[matchId][propIdx];

        uint256 payout;
        Outcome o = pr.outcome;
        if (o == Outcome.Yes) {
            uint256 s = propStakeYes[matchId][propIdx][msg.sender];
            require(s > 0, "no winning stake");
            payout = (uint256(pr.netPot) * s) / pr.winningPool;
        } else if (o == Outcome.No) {
            uint256 s = propStakeNo[matchId][propIdx][msg.sender];
            require(s > 0, "no winning stake");
            payout = (uint256(pr.netPot) * s) / pr.winningPool;
        } else if (o == Outcome.Void) {
            uint256 s = uint256(propStakeYes[matchId][propIdx][msg.sender]) + propStakeNo[matchId][propIdx][msg.sender];
            require(s > 0, "no stake");
            payout = s;
        } else {
            revert("unexpected outcome");
        }

        propClaimed[matchId][propIdx][msg.sender] = true;
        require(betToken.transfer(msg.sender, payout), "transfer failed");
        emit PropClaimed(matchId, propIdx, msg.sender, payout);
    }

    event PropRefunded(uint256 indexed matchId, uint256 indexed propIdx, address indexed user, uint256 payout);

    /// @notice Reclaim a side-market stake when the match was abandoned (RefundMode). Mirrors refund().
    function refundProp(uint256 matchId, uint256 propIdx) external {
        require(matches[matchId].state == MatchState.RefundMode, "not refund mode");
        require(!propClaimed[matchId][propIdx][msg.sender], "already refunded");
        uint256 s = uint256(propStakeYes[matchId][propIdx][msg.sender]) + propStakeNo[matchId][propIdx][msg.sender];
        require(s > 0, "no stake");
        propClaimed[matchId][propIdx][msg.sender] = true;
        require(betToken.transfer(msg.sender, s), "transfer failed");
        emit PropRefunded(matchId, propIdx, msg.sender, s);
    }

    /// @notice Number of side markets attached to a match (Survival: one per seat).
    function propCount(uint256 matchId) external view returns (uint256) {
        return _props[matchId].length;
    }

    /// @notice Read one side market's full state (kind, seat, pools, settled outcome).
    function getProp(uint256 matchId, uint256 propIdx) external view returns (Prop memory) {
        return _props[matchId][propIdx];
    }
}
