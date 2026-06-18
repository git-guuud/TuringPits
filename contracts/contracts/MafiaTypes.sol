// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Role enum order MUST match engine/src/commit.ts ROLE_ENUM (MAFIA=0..TOWN=3).
enum Role { MAFIA, DOCTOR, DETECTIVE, TOWN }
enum Phase { Night, Day }
enum Action { Kill, Save, Investigate, Vote }
enum Side { No, Yes } // Yes = "Mafia wins"

/// @notice The structured decision the TEE binds and the state machine consumes.
/// @dev `nonce` is match-level (shared by all moves), so it is not stored per-Decision.
struct Decision {
    Phase phase;
    uint32 round;
    uint8 player;
    Action action;
    uint8 target;
}
