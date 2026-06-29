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

    /// @notice The per-round "voted out" outcome: per seat, the 1-based round whose day vote
    ///         eliminated it (0 = never voted out). Drives every per-round VotedOut band's settlement.
    function votedOutRounds(Role[] calldata roles, Decision[] calldata decisions) external pure returns (uint8[] memory) {
        MafiaRules.Game memory g = MafiaRules.init(roles);
        for (uint256 i = 0; i < decisions.length; i++) {
            MafiaRules.applyDecision(g, decisions[i]);
        }
        return g.votedOutRound;
    }

    /// @notice The "round of death" outcome: per seat, the 1-based round it was eliminated in (0 if
    ///         it survived to the end). Drives the round-of-death side market's settlement.
    function deathRounds(Role[] calldata roles, Decision[] calldata decisions) external pure returns (uint8[] memory) {
        MafiaRules.Game memory g = MafiaRules.init(roles);
        for (uint256 i = 0; i < decisions.length; i++) {
            MafiaRules.applyDecision(g, decisions[i]);
        }
        return g.deathRound;
    }
}
