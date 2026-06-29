// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./lib/ERC2771Context.sol";

/// @title MockBetToken — the faucet-mintable ERC20 used as TuringPits' betting currency.
/// @dev # MOCK: this is NOT a real asset and carries no value. Anyone can mint themselves free
///      test tokens via `faucet()` (no cooldown, no access control — demo-only by design). It
///      exists so wagers flow through a real ERC20 (approve + transferFrom) rather than the native
///      0G gas token, while every on-chain market mechanic it touches — parimutuel pools, payouts,
///      refunds, fees — stays real. Standard ERC20, 18 decimals.
///
///      Gasless-ready: inherits ERC2771Context so a relayed faucet()/approve()/transfer() is
///      attributed to the original user (lets a wallet with zero native 0G mint + approve CHIP via
///      the optional gas relayer). Direct calls are unchanged (_msgSender() == msg.sender).
contract MockBetToken is ERC2771Context {
    string public constant name = "Pit Chips";
    string public constant symbol = "CHIP";
    uint8 public constant decimals = 18;

    /// @notice Test CHIP handed out per `faucet()` call.
    uint256 public constant FAUCET_AMOUNT = 1000 ether;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @param _trustedForwarder the EIP-2771 Forwarder allowed to relay faucet/approve/transfer
    ///        (pass address(0) to disable relaying).
    constructor(address _trustedForwarder) ERC2771Context(_trustedForwarder) {}

    /// @notice # MOCK: mint free test CHIP to the caller. Demo faucet — no cooldown, no limit.
    function faucet() external {
        _mint(_msgSender(), FAUCET_AMOUNT);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(_msgSender(), to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[_msgSender()][spender] = amount;
        emit Approval(_msgSender(), spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][_msgSender()];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "insufficient allowance");
            allowance[from][_msgSender()] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "transfer to zero");
        uint256 bal = balanceOf[from];
        require(bal >= amount, "insufficient balance");
        unchecked {
            balanceOf[from] = bal - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
