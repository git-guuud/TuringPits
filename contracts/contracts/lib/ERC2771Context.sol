// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ERC2771Context — minimal EIP-2771 meta-transaction support.
/// @notice Lets a contract attribute a call to the ORIGINAL user when it is relayed through a
///         trusted Forwarder that appends the user's 20-byte address to the calldata. Used by
///         MafiaMarket + MockBetToken so a user with zero native 0G can still bet/claim/mint via
///         the optional gas relayer (the relayer pays gas; the user stays the on-chain actor).
/// @dev    OPTIONAL by construction: `_msgSender()` only strips the appended sender when the caller
///         IS `trustedForwarder`. Every direct call (the host, or a user who has their own gas) sees
///         `_msgSender() == msg.sender`, so the relayer changes nothing for non-relayed paths. Set
///         `trustedForwarder` to address(0) to disable relaying entirely (msg.sender can never be 0).
abstract contract ERC2771Context {
    /// @notice The only contract allowed to relay calls on a user's behalf. Immutable; address(0)
    ///         means "no relayer" (the contract behaves like a normal msg.sender contract).
    address public immutable trustedForwarder;

    constructor(address _trustedForwarder) {
        trustedForwarder = _trustedForwarder;
    }

    /// @return sender The relayed user when called via the trusted forwarder, else the direct caller.
    function _msgSender() internal view returns (address sender) {
        if (msg.sender == trustedForwarder && msg.data.length >= 20) {
            // The forwarder appends the original sender as the trailing 20 bytes of calldata.
            assembly {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }
}
