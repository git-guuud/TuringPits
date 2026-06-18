// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../MafiaTypes.sol";
import "../lib/MafiaRules.sol";

contract MafiaRulesHarness {
    function winner(Role[] calldata roles, Decision[] calldata decisions) external pure returns (bool over, bool mafiaWins) {
        MafiaRules.Game memory g = MafiaRules.init(roles);
        for (uint256 i = 0; i < decisions.length; i++) {
            MafiaRules.applyDecision(g, decisions[i]);
        }
        return (g.over, g.mafiaWins);
    }
}
