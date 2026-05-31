// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

library Client {
    struct EVMTokenAmount {
        address token;
        uint256 amount;
    }

    struct EVM2AnyMessage {
        bytes receiver;
        bytes data;
        EVMTokenAmount[] tokenAmounts;
        address feeToken;
        bytes extraArgs;
    }

    bytes4 public constant SVM_EXTRA_ARGS_V1_TAG = 0x1f3b3aba;

    struct SVMExtraArgsV1 {
        uint32 computeUnits;
        uint64 accountIsWritableBitmap;
        bool allowOutOfOrderExecution;
        bytes32 tokenReceiver;
        bytes32[] accounts;
    }

    function _svmArgsToBytes(SVMExtraArgsV1 memory extraArgs) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SVM_EXTRA_ARGS_V1_TAG, extraArgs);
    }
}
