// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../MafiaTypes.sol";

/// @dev Solidity port of engine/src/moderator.ts. Mutates a memory `Game` in place.
///      Nonce/phase/round binding for cross-match replay is enforced by the caller
///      (MafiaMarket binds each decision to the signed body via the match nonce).
library MafiaRules {
    struct Game {
        Role[] roles;
        bool[] alive;
        Phase phase;
        uint32 round;
        uint8[] pendingPlayer;
        Action[] pendingAction;
        uint8[] pendingTarget;
        uint8 pendingCount;
        bool[] acted;
        bool over;
        bool mafiaWins;
        // The per-round "voted out" market resolves from this: votedOutRound[seat] is the 1-based
        // round whose DAY VOTE eliminated that seat, or 0 if the seat was never voted out (it
        // survived, or fell to a night kill). A seat is voted out at most once, so each entry is
        // written at most once. A VotedOut prop for round R pays YES iff votedOutRound[seat] == R;
        // a tied/absent day vote in round R leaves every seat at 0 for that round → all NO.
        uint8[] votedOutRound;
        // The "round of death" market resolves from this: deathRound[seat] is the 1-based round in
        // which that seat was eliminated (the night kill or the day vote), or 0 if the seat is still
        // alive when the transcript ends. Rounds are 1-based, so 0 is an unambiguous "survived"
        // sentinel. A seat dies at most once, so each entry is written at most once.
        uint8[] deathRound;
    }

    function init(Role[] memory roles) internal pure returns (Game memory g) {
        uint256 n = roles.length;
        g.roles = roles;
        g.alive = new bool[](n);
        for (uint256 i = 0; i < n; i++) g.alive[i] = true;
        g.phase = Phase.Night;
        g.round = 1;
        g.pendingPlayer = new uint8[](n);
        g.pendingAction = new Action[](n);
        g.pendingTarget = new uint8[](n);
        g.acted = new bool[](n);
        g.deathRound = new uint8[](n);
        g.votedOutRound = new uint8[](n);
    }

    function applyDecision(Game memory g, Decision memory d) internal pure {
        _assertLegal(g, d);
        g.pendingPlayer[g.pendingCount] = d.player;
        g.pendingAction[g.pendingCount] = d.action;
        g.pendingTarget[g.pendingCount] = d.target;
        g.pendingCount++;
        g.acted[d.player] = true;
        if (_complete(g)) {
            if (g.phase == Phase.Night) _resolveNight(g);
            else _resolveDay(g);
        }
    }

    function _assertLegal(Game memory g, Decision memory d) private pure {
        require(!g.over, "game over");
        require(d.phase == g.phase && d.round == g.round, "out of order");
        uint256 n = g.roles.length;
        require(d.player < n, "player oob");
        require(d.target < n, "target oob");
        require(g.alive[d.player], "actor dead");
        require(g.alive[d.target], "target dead");
        if (g.phase == Phase.Day) {
            require(d.action == Action.Vote, "action not valid in day");
        } else {
            require(d.action != Action.Vote, "vote not valid in night");
            Role req = d.action == Action.Kill
                ? Role.MAFIA
                : (d.action == Action.Save ? Role.DOCTOR : Role.DETECTIVE);
            require(g.roles[d.player] == req, "role cannot act");
        }
        require(!g.acted[d.player], "already acted");
    }

    function _expectedCount(Game memory g) private pure returns (uint8 c) {
        for (uint8 i = 0; i < g.roles.length; i++) {
            if (!g.alive[i]) continue;
            if (g.phase == Phase.Day) c++;
            else if (g.roles[i] == Role.MAFIA || g.roles[i] == Role.DOCTOR || g.roles[i] == Role.DETECTIVE) c++;
        }
    }

    function _complete(Game memory g) private pure returns (bool) {
        uint8 exp = _expectedCount(g);
        return exp > 0 && g.pendingCount == exp;
    }

    function _resolveNight(Game memory g) private pure {
        (bool hasKill, uint8 killTarget) = _pluralityByAction(g, Action.Kill);
        (bool hasSave, uint8 saveTarget) = _firstByAction(g, Action.Save);
        if (hasKill && !(hasSave && saveTarget == killTarget)) {
            g.alive[killTarget] = false;
            // The night kill happens in the current round (round only advances after the day phase),
            // so g.round is this death's round — the "round of death" outcome for that seat.
            g.deathRound[killTarget] = uint8(g.round);
        }
        // Investigations are win-neutral; skipped on-chain.
        g.phase = Phase.Day;
        _clearPending(g);
        _computeWinner(g);
    }

    function _resolveDay(Game memory g) private pure {
        (bool hasElim, uint8 elim) = _pluralityAll(g);
        if (hasElim) {
            g.alive[elim] = false;
            // Record BEFORE the round++ below, so the day-vote death is attributed to the current
            // round — both its "round of death" and its per-round "voted out" outcome.
            g.deathRound[elim] = uint8(g.round);
            // This seat was voted out by THIS round's day vote — the per-round VotedOut outcome.
            g.votedOutRound[elim] = uint8(g.round);
        }
        g.phase = Phase.Night;
        g.round += 1;
        _clearPending(g);
        _computeWinner(g);
    }

    function _pluralityByAction(Game memory g, Action a) private pure returns (bool, uint8) {
        uint16[] memory counts = new uint16[](g.roles.length);
        for (uint8 i = 0; i < g.pendingCount; i++) {
            if (g.pendingAction[i] == a) counts[g.pendingTarget[i]]++;
        }
        return _argmax(counts);
    }

    function _pluralityAll(Game memory g) private pure returns (bool, uint8) {
        uint16[] memory counts = new uint16[](g.roles.length);
        for (uint8 i = 0; i < g.pendingCount; i++) counts[g.pendingTarget[i]]++;
        return _argmax(counts);
    }

    /// @dev Strict plurality; ties (two targets share the max) return (false, 0). Matches
    ///      engine plurality(): order-independent winner/tie determination.
    function _argmax(uint16[] memory counts) private pure returns (bool, uint8) {
        bool found = false;
        bool tied = false;
        uint8 best = 0;
        uint16 bestC = 0;
        for (uint8 t = 0; t < counts.length; t++) {
            uint16 c = counts[t];
            if (c == 0) continue;
            if (c > bestC) { best = t; bestC = c; tied = false; found = true; }
            else if (c == bestC) { tied = true; }
        }
        if (!found || tied) return (false, 0);
        return (true, best);
    }

    function _firstByAction(Game memory g, Action a) private pure returns (bool, uint8) {
        for (uint8 i = 0; i < g.pendingCount; i++) {
            if (g.pendingAction[i] == a) return (true, g.pendingTarget[i]);
        }
        return (false, 0);
    }

    function _clearPending(Game memory g) private pure {
        g.pendingCount = 0;
        for (uint8 i = 0; i < g.acted.length; i++) g.acted[i] = false;
    }

    function _computeWinner(Game memory g) private pure {
        uint8 mafia = 0;
        uint8 town = 0;
        for (uint8 i = 0; i < g.roles.length; i++) {
            if (!g.alive[i]) continue;
            if (g.roles[i] == Role.MAFIA) mafia++;
            else town++;
        }
        if (mafia == 0) { g.over = true; g.mafiaWins = false; }
        else if (mafia >= town) { g.over = true; g.mafiaWins = true; }
    }
}
