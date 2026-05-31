// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Client} from "./ccip/Client.sol";
import {IRouterClient} from "./ccip/IRouterClient.sol";
import {IERC20} from "./ccip/IERC20.sol";

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

contract AltPayCreSender is IReceiver {
    address public owner;
    address public forwarder;
    IRouterClient public router;
    address public feeToken;
    uint64 public destChainSelector;
    bytes32 public solanaReceiver;
    bytes32 public tokenReceiver;
    uint32 public computeUnits;

    uint256 public reportCount;
    bytes public lastReport;
    bytes32 public lastMessageId;

    event ReportReceived(address indexed sender, uint256 indexed count, uint16 score, bool approved, uint64 amount);
    event CcipSent(bytes32 indexed messageId, bytes32 indexed loanDecisionPda, uint64 amount, uint256 fee);
    event ForwarderSet(address indexed forwarder);

    error NotForwarder(address sender);
    error NotOwner(address sender);
    error InsufficientFee(uint256 fee, uint256 balance);

    constructor(
        address _forwarder,
        address _router,
        address _feeToken,
        uint64 _destChainSelector,
        bytes32 _solanaReceiver,
        bytes32 _tokenReceiver,
        uint32 _computeUnits
    ) {
        owner = msg.sender;
        forwarder = _forwarder == address(0)
            ? 0x15fC6ae953E024d975e77382eEeC56A9101f9F88
            : _forwarder;
        router = IRouterClient(_router);
        feeToken = _feeToken;
        destChainSelector = _destChainSelector;
        solanaReceiver = _solanaReceiver;
        tokenReceiver = _tokenReceiver;
        computeUnits = _computeUnits == 0 ? 200_000 : _computeUnits;
        emit ForwarderSet(forwarder);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    function setForwarder(address _forwarder) external onlyOwner {
        forwarder = _forwarder;
        emit ForwarderSet(_forwarder);
    }

    function setRouter(address _router) external onlyOwner {
        router = IRouterClient(_router);
    }

    function setSolanaReceiver(bytes32 _receiver) external onlyOwner {
        solanaReceiver = _receiver;
    }

    function setFeeToken(address _feeToken) external onlyOwner {
        feeToken = _feeToken;
    }

    receive() external payable {}

    function onReport(bytes calldata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        lastReport = report;
        reportCount += 1;

        (
            bytes32 cpfHash,
            bytes32 borrowerSol32,
            uint16 score,
            bool approved,
            uint64 amount,
            bytes32 loanDecisionPda32,
            uint64 writableBitmap
        ) = abi.decode(report, (bytes32, bytes32, uint16, bool, uint64, bytes32, uint64));

        emit ReportReceived(msg.sender, reportCount, score, approved, amount);
        if (!approved) return;

        bytes memory data = abi.encodePacked(cpfHash, borrowerSol32, _le16(score), approved, _le64(amount));

        bytes32[] memory accounts = new bytes32[](1);
        accounts[0] = loanDecisionPda32;

        Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
            receiver: abi.encode(solanaReceiver),
            data: data,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: feeToken,
            extraArgs: Client._svmArgsToBytes(
                Client.SVMExtraArgsV1({
                    computeUnits: computeUnits,
                    accountIsWritableBitmap: writableBitmap,
                    allowOutOfOrderExecution: true,
                    tokenReceiver: tokenReceiver,
                    accounts: accounts
                })
            )
        });

        uint256 fee = router.getFee(destChainSelector, message);
        bytes32 messageId;
        if (feeToken == address(0)) {
            if (fee > address(this).balance) revert InsufficientFee(fee, address(this).balance);
            messageId = router.ccipSend{value: fee}(destChainSelector, message);
        } else {
            uint256 balance = IERC20(feeToken).balanceOf(address(this));
            if (fee > balance) revert InsufficientFee(fee, balance);
            IERC20(feeToken).approve(address(router), fee);
            messageId = router.ccipSend(destChainSelector, message);
        }
        lastMessageId = messageId;
        emit CcipSent(messageId, loanDecisionPda32, amount, fee);
    }

    function _le16(uint16 v) internal pure returns (bytes2) {
        return bytes2(uint16((v >> 8) | (v << 8)));
    }

    function _le64(uint64 v) internal pure returns (bytes8) {
        v = ((v & 0x00FF00FF00FF00FF) << 8) | ((v & 0xFF00FF00FF00FF00) >> 8);
        v = ((v & 0x0000FFFF0000FFFF) << 16) | ((v & 0xFFFF0000FFFF0000) >> 16);
        v = (v << 32) | (v >> 32);
        return bytes8(v);
    }

    function withdrawNative(address to) external onlyOwner {
        (bool ok,) = to.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }

    function withdrawToken(address token, address to) external onlyOwner {
        IERC20 t = IERC20(token);
        require(t.transfer(to, t.balanceOf(address(this))), "withdraw failed");
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
