// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Forwarder — minimal EIP-712 trusted forwarder for EIP-2771 meta-transactions.
/// @notice The single contract that ERC2771Context consumers (MafiaMarket, MockBetToken) trust. A
///         user signs a ForwardRequest off-chain (no gas); the relayer submits it here via
///         execute(), which verifies the EIP-712 signature, bumps the user's nonce, and forwards the
///         call to `req.to` with `req.from` appended to the calldata so the target attributes the
///         action to the user (see ERC2771Context._msgSender). The relayer — not the user — pays gas.
/// @dev    Hand-rolled (no OpenZeppelin dep), modelled on OZ's MinimalForwarder. Replay-safe via a
///         per-from nonce; time-bounded via `deadline`. The forwarder holds no funds and grants no
///         privilege — it only proves "this user authorized this exact call".
contract Forwarder {
    struct ForwardRequest {
        address from;     // the user the call is attributed to (signer)
        address to;       // target contract (MafiaMarket / MockBetToken)
        uint256 value;    // native value to forward (always 0 for our actions)
        uint256 gas;      // gas to forward to the inner call
        uint256 nonce;    // must equal nonces[from]
        uint48 deadline;  // unix seconds; request is invalid after this
        bytes data;       // ABI-encoded call (e.g. betProp(matchId, propIdx, outcome, amount))
    }

    string public constant name = "TuringPitsForwarder";
    string public constant version = "1";

    bytes32 private constant _TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)"
    );
    bytes32 private constant _DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @notice Next expected nonce per user — the replay guard. Each successful execute() bumps it.
    mapping(address => uint256) public nonces;

    event Forwarded(address indexed from, address indexed to, uint256 nonce, bool success);

    /// @notice Next nonce a `from` must sign — the frontend reads this to build a request.
    function getNonce(address from) external view returns (uint256) {
        return nonces[from];
    }

    /// @notice The EIP-712 domain separator (chainId-bound, so a sig can't be replayed across chains).
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this))
        );
    }

    /// @notice True iff `signature` is `req.from`'s valid EIP-712 signature over `req`, the nonce is
    ///         current, and the deadline hasn't passed. The relayer view-calls this BEFORE spending
    ///         gas so it never submits a doomed (reverting) transaction.
    function verify(ForwardRequest calldata req, bytes calldata signature) public view returns (bool) {
        if (req.nonce != nonces[req.from]) return false;
        if (block.timestamp > req.deadline) return false;
        address signer = _recover(_hashTypedData(req), signature);
        return signer == req.from;
    }

    /// @notice Verify + execute a meta-transaction. Forwards `req.data` to `req.to` with `req.from`
    ///         appended (EIP-2771), so the target sees the user as `_msgSender()`. Reverts the whole
    ///         tx on a bad/expired signature or wrong nonce; bubbles up the inner call's revert.
    /// @return success Whether the forwarded call succeeded.
    /// @return ret The returndata of the forwarded call.
    function execute(ForwardRequest calldata req, bytes calldata signature)
        external
        payable
        returns (bool success, bytes memory ret)
    {
        require(req.nonce == nonces[req.from], "bad nonce");
        require(block.timestamp <= req.deadline, "request expired");
        require(_recover(_hashTypedData(req), signature) == req.from, "bad signature");

        nonces[req.from] = req.nonce + 1;

        (success, ret) = req.to.call{gas: req.gas, value: req.value}(abi.encodePacked(req.data, req.from));

        if (!success) {
            // EIP-2771/OZ pattern: ensure enough gas was actually forwarded so a relayer can't grief
            // by starving the inner call (a 63/64 underfund could make a real call appear to fail).
            // If 1/64 of remaining gas can't cover req.gas/63, not enough was forwarded → hard revert.
            if (gasleft() <= req.gas / 63) {
                assembly { invalid() }
            }
            // Bubble the inner call's exact revert data up (preserves Error(string) like "below min
            // bet"), so the relayer/bettor sees the real reason.
            assembly { revert(add(ret, 0x20), mload(ret)) }
        }

        emit Forwarded(req.from, req.to, req.nonce, success);
    }

    function _hashTypedData(ForwardRequest calldata req) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(_TYPEHASH, req.from, req.to, req.value, req.gas, req.nonce, req.deadline, keccak256(req.data))
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 0x20))
            v := byte(0, calldataload(add(sig.offset, 0x40)))
        }
        // Reject the upper half of the curve order (EIP-2 malleability) and v ∈ {27,28}.
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "bad s");
        require(v == 27 || v == 28, "bad v");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad signature");
        return signer;
    }
}
