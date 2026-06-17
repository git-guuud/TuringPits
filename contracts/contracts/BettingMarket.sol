// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BettingMarket — binary YES/NO escrow for a single Turing Pits match.
/// @notice MVP scope (TODO.md Day 4). Full AMM + slashing are deferred post-lock.
/// @dev This is a SCAFFOLD: function bodies are unimplemented. The lifecycle is:
///      openMarket(commit) -> placeBet -> lockBetting -> revealSeed -> settle -> claim.
contract BettingMarket {
    enum State { Open, Locked, Settled }
    enum Side { No, Yes }

    /// @notice keccak256 commitment to the secret seed, set before betting opens.
    bytes32 public seedCommit;
    State public state;

    // TODO(Day 4): YES/NO pools, per-bettor positions, winning side, oracle pubkey.

    /// @notice Host opens the market by committing to a hashed seed.
    function openMarket(bytes32 commitHash) external {
        // TODO(Day 4)
        seedCommit = commitHash; // placeholder so the field is exercised
        state = State.Open;
    }

    /// @notice Place a bet on YES or NO while the market is Open.
    function placeBet(Side /*side*/) external payable {
        // TODO(Day 4)
        revert("not implemented");
    }

    /// @notice Lock betting; no new bets after this.
    function lockBetting() external {
        // TODO(Day 4)
        revert("not implemented");
    }

    /// @notice Reveal the seed; must hash to seedCommit.
    function revealSeed(bytes32 /*seed*/) external {
        // TODO(Day 4)
        revert("not implemented");
    }

    /// @notice Settle with the verified winner, gated on a valid 0G Compute signature.
    function settle(Side /*winner*/, bytes calldata /*oracleSig*/) external {
        // TODO(Day 4/5): verify oracleSig before settling.
        revert("not implemented");
    }

    /// @notice Winning bettors claim their payout after settlement.
    function claim() external {
        // TODO(Day 4)
        revert("not implemented");
    }
}
