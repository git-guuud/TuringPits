// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./StrUtils.sol";

/// @dev Reconstructs the live-confirmed 0G-TEE envelope and recovers its EIP-191 signer.
///      Envelope = sha256(req):sha256(res):provider_type:provider_identity:tls_fingerprint,
///      where sha256(res) = lowercase hex of sha256(rawResponseBody).
library TeeEnvelope {
    function recover(
        bytes memory rawResponseBody,
        string memory reqHashHex,
        string memory providerType,
        string memory providerIdentity,
        string memory tlsFingerprint,
        bytes memory signature
    ) internal pure returns (address) {
        string memory resHashHex = StrUtils.toHex(sha256(rawResponseBody));
        string memory envelope = string.concat(
            reqHashHex, ":", resHashHex, ":", providerType, ":", providerIdentity, ":", tlsFingerprint
        );
        bytes32 digest = _ethSignedHash(envelope);
        return _recover(digest, signature);
    }

    function _ethSignedHash(string memory message) private pure returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n", StrUtils.toString(bytes(message).length), message)
        );
    }

    function _recover(bytes32 hash, bytes memory sig) private pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }
}
