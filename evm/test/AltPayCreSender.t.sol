// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AltPayCreSender} from "../src/AltPayCreSender.sol";

contract Harness is AltPayCreSender {
    constructor()
        AltPayCreSender(
            address(0),
            address(0x1),
            address(0x2),
            16423721717087811551,
            bytes32(uint256(1)),
            bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)),
            200_000
        )
    {}

    function pack(bytes32 cpfHash, bytes32 borrowerSol32, uint16 score, bool approved, uint64 amount)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(cpfHash, borrowerSol32, _le16(score), approved, _le64(amount));
    }
}

contract AltPayCreSenderTest {
    Harness h;

    function setUp() public {
        h = new Harness();
    }

    function test_dataLayoutIs75BytesLittleEndian() public {
        if (address(h) == address(0)) h = new Harness();
        bytes32 cpf = bytes32(uint256(0xAA));
        bytes32 borrower = 0xa9962b66e8e70cc8131c3a42a83afde3ca803e0f3a421f339a261f144f503931;
        uint16 score = 1000;
        bool approved = true;
        uint64 amount = 200000;

        bytes memory data = h.pack(cpf, borrower, score, approved, amount);
        require(data.length == 75, "len != 75");

        require(bytes32(_slice(data, 0, 32)) == cpf, "cpf mismatch");
        require(bytes32(_slice(data, 32, 32)) == borrower, "borrower mismatch");

        uint16 scoreLe = uint16(uint8(data[64])) | (uint16(uint8(data[65])) << 8);
        require(scoreLe == score, "score LE mismatch");

        require(uint8(data[66]) == 1, "approved byte mismatch");

        uint64 amountLe;
        for (uint256 i = 0; i < 8; i++) {
            amountLe |= uint64(uint8(data[67 + i])) << uint64(8 * i);
        }
        require(amountLe == amount, "amount LE mismatch");
    }

    function _slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = b[start + i];
        }
    }
}
