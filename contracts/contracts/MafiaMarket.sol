// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MafiaTypes.sol";
import "./lib/DecisionCodec.sol";
import "./lib/TeeEnvelope.sol";
import "./lib/MafiaRules.sol";

/// @title MafiaMarket — parimutuel YES/NO faction-win market with fully on-chain,
///        TEE-verified, trustless settlement for one AI-Mafia match.
contract MafiaMarket {
    enum State { Open, Locked, Settled }

    struct Move {
        Decision decision;
        bytes rawResponseBody;
        uint256 contentOffset;
        uint256 contentLen;
        string reqHashHex;
        bytes signature;
    }

    address public host;
    State public state;

    bytes32 public roleCommit;
    address public teeSigner;
    string public providerType;
    string public providerIdentity;
    string public tlsFingerprint;
    string public nonce;
    uint8 public playerCount;

    uint256 public yesPool;
    uint256 public noPool;
    mapping(address => uint256) public yesStake;
    mapping(address => uint256) public noStake;

    Side public winningSide;
    mapping(address => bool) public claimed;

    modifier onlyHost() {
        require(msg.sender == host, "not host");
        _;
    }

    constructor() {
        host = msg.sender;
    }

    function openMarket(
        bytes32 _roleCommit,
        address _teeSigner,
        string calldata _providerType,
        string calldata _providerIdentity,
        string calldata _tlsFingerprint,
        string calldata _nonce,
        uint8 _playerCount
    ) external onlyHost {
        require(roleCommit == bytes32(0), "already opened");
        require(_playerCount >= 5 && _playerCount <= 7, "bad player count");
        require(_teeSigner != address(0), "zero signer");
        roleCommit = _roleCommit;
        teeSigner = _teeSigner;
        providerType = _providerType;
        providerIdentity = _providerIdentity;
        tlsFingerprint = _tlsFingerprint;
        nonce = _nonce;
        playerCount = _playerCount;
        state = State.Open;
    }

    function placeBet(Side side) external payable {
        require(state == State.Open, "betting not open");
        require(roleCommit != bytes32(0), "market not opened");
        require(msg.value > 0, "zero stake");
        if (side == Side.Yes) { yesPool += msg.value; yesStake[msg.sender] += msg.value; }
        else { noPool += msg.value; noStake[msg.sender] += msg.value; }
    }

    function lockBetting() external onlyHost {
        require(state == State.Open, "not open");
        state = State.Locked;
    }

    function settle(Move[] calldata moves, Role[] calldata revealedRoles, bytes32 salt) external onlyHost {
        require(state == State.Locked, "not locked");

        // 1. Commit-reveal: sha256(roleBytes ++ salt) == roleCommit (precompile 0x2).
        require(revealedRoles.length == playerCount, "roles length");
        bytes memory roleBytes = new bytes(revealedRoles.length);
        for (uint256 i = 0; i < revealedRoles.length; i++) {
            roleBytes[i] = bytes1(uint8(revealedRoles[i]));
        }
        require(sha256(bytes.concat(roleBytes, salt)) == roleCommit, "role reveal mismatch");

        // 2. Verify each move's TEE envelope + bind its decision to the signed body, then apply.
        MafiaRules.Game memory g = MafiaRules.init(revealedRoles);
        for (uint256 i = 0; i < moves.length; i++) {
            Move calldata mv = moves[i];
            address signer = TeeEnvelope.recover(
                mv.rawResponseBody, mv.reqHashHex, providerType, providerIdentity, tlsFingerprint, mv.signature
            );
            require(signer == teeSigner, "bad TEE signature");

            string memory expected = DecisionCodec.jsonEscape(DecisionCodec.encode(nonce, mv.decision));
            require(_sliceEquals(mv.rawResponseBody, mv.contentOffset, mv.contentLen, bytes(expected)), "decision not bound to body");

            MafiaRules.applyDecision(g, mv.decision); // reverts on illegal/out-of-order
        }

        // 3. The decisions must complete a game.
        require(g.over, "decisions do not complete a game");
        winningSide = g.mafiaWins ? Side.Yes : Side.No;
        state = State.Settled;
    }

    function claim() external {
        require(state == State.Settled, "not settled");
        require(!claimed[msg.sender], "already claimed");
        uint256 winnerStake = winningSide == Side.Yes ? yesStake[msg.sender] : noStake[msg.sender];
        require(winnerStake > 0, "nothing to claim");
        uint256 winningPool = winningSide == Side.Yes ? yesPool : noPool;
        uint256 payout = ((yesPool + noPool) * winnerStake) / winningPool;
        claimed[msg.sender] = true;
        (bool ok, ) = msg.sender.call{value: payout}("");
        require(ok, "transfer failed");
    }

    function _sliceEquals(bytes calldata body, uint256 offset, uint256 len, bytes memory expected) private pure returns (bool) {
        if (offset + len > body.length) return false;
        if (len != expected.length) return false;
        return keccak256(body[offset:offset + len]) == keccak256(expected);
    }
}
