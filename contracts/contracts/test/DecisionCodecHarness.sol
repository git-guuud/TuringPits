// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../MafiaTypes.sol";
import "../lib/DecisionCodec.sol";

contract DecisionCodecHarness {
    function encode(string calldata nonce, Decision calldata d) external pure returns (string memory) {
        return DecisionCodec.encode(nonce, d);
    }

    function escapedEncode(string calldata nonce, Decision calldata d) external pure returns (string memory) {
        return DecisionCodec.jsonEscape(DecisionCodec.encode(nonce, d));
    }
}
