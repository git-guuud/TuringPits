// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library StrUtils {
    /// @dev uint -> decimal string (OZ Strings pattern).
    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) { digits -= 1; buffer[digits] = bytes1(uint8(48 + (value % 10))); value /= 10; }
        return string(buffer);
    }

    /// @dev 32 bytes -> 64-char lowercase hex (no 0x), matching node crypto digest("hex").
    function toHex(bytes32 data) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            str[i * 2] = alphabet[uint8(data[i] >> 4)];
            str[i * 2 + 1] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }
}
