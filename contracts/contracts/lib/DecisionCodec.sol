// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../MafiaTypes.sol";
import "./StrUtils.sol";

/// @dev Reconstructs engine/src/encoding.ts encodeDecision byte-for-byte, plus JSON escaping
///      so the decision can be matched against the (escaped) content inside the signed body.
library DecisionCodec {
    function _phase(Phase p) private pure returns (string memory) {
        return p == Phase.Night ? '"night"' : '"day"';
    }

    function _action(Action a) private pure returns (string memory) {
        if (a == Action.Kill) return '"kill"';
        if (a == Action.Save) return '"save"';
        if (a == Action.Investigate) return '"investigate"';
        return '"vote"';
    }

    /// @dev Escapes the two characters our decision strings can contain that JSON requires
    ///      escaping: `"` -> `\"` and `\` -> `\\`. (No control chars appear.)
    function jsonEscape(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length * 2);
        uint256 j;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == '"' || c == "\\") { out[j++] = "\\"; out[j++] = c; }
            else { out[j++] = c; }
        }
        bytes memory trimmed = new bytes(j);
        for (uint256 i = 0; i < j; i++) trimmed[i] = out[i];
        return string(trimmed);
    }

    function _jsonString(string memory s) private pure returns (string memory) {
        return string.concat('"', jsonEscape(s), '"');
    }

    /// @notice The canonical decision string == engine encodeDecision(d) with this nonce.
    function encode(string memory nonce, Decision memory d) internal pure returns (string memory) {
        return string.concat(
            '{"nonce":', _jsonString(nonce),
            ',"phase":', _phase(d.phase),
            ',"round":', StrUtils.toString(d.round),
            ',"player":', StrUtils.toString(d.player),
            ',"action":', _action(d.action),
            ',"target":', StrUtils.toString(d.target),
            "}"
        );
    }
}
