// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../lib/TeeEnvelope.sol";

contract TeeEnvelopeHarness {
    function recover(
        bytes calldata rawResponseBody,
        string calldata reqHashHex,
        string calldata providerType,
        string calldata providerIdentity,
        string calldata tlsFingerprint,
        bytes calldata signature
    ) external pure returns (address) {
        return TeeEnvelope.recover(rawResponseBody, reqHashHex, providerType, providerIdentity, tlsFingerprint, signature);
    }
}
