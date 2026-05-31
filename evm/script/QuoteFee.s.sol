// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Client} from "../src/ccip/Client.sol";
import {IRouterClient} from "../src/ccip/IRouterClient.sol";

contract QuoteFee is Script {
    address constant ROUTER = 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59;
    address constant LINK = 0x779877A7B0D9E8603169DdbD7836e478b4624789;
    uint64 constant SOLANA_DEVNET = 16423721717087811551;

    function run() external view {
        bytes32 solanaReceiver = 0x1111111111111111111111111111111111111111111111111111111111111111;
        bytes32 loanDecisionPda = 0x3333333333333333333333333333333333333333333333333333333333333333;

        bytes memory data = new bytes(75);

        bytes32[] memory accounts = new bytes32[](1);
        accounts[0] = loanDecisionPda;

        Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
            receiver: abi.encode(solanaReceiver),
            data: data,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: LINK,
            extraArgs: Client._svmArgsToBytes(
                Client.SVMExtraArgsV1({
                    computeUnits: 200_000,
                    accountIsWritableBitmap: 1,
                    allowOutOfOrderExecution: true,
                    tokenReceiver: 0x1111111111111111111111111111111111111111111111111111111111111111,
                    accounts: accounts
                })
            )
        });

        uint256 feeLink = IRouterClient(ROUTER).getFee(SOLANA_DEVNET, message);
        console2.log("fee LINK (juels):", feeLink);

        message.feeToken = address(0);
        uint256 feeNative = IRouterClient(ROUTER).getFee(SOLANA_DEVNET, message);
        console2.log("fee NATIVE (wei):", feeNative);
    }
}
