// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

contract GateStubConsumer is IReceiver {
    address public forwarder;
    address public owner;

    bytes public lastReport;
    bytes public lastMetadata;
    uint256 public reportCount;

    event ReportReceived(address indexed sender, uint256 indexed count, bytes metadata, bytes report);
    event ForwarderSet(address indexed forwarder);

    error NotForwarder(address sender);
    error NotOwner(address sender);

    constructor(address _forwarder) {
        owner = msg.sender;
        forwarder = _forwarder == address(0)
            ? 0x15fC6ae953E024d975e77382eEeC56A9101f9F88
            : _forwarder;
        emit ForwarderSet(forwarder);
    }

    function setForwarder(address _forwarder) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        forwarder = _forwarder;
        emit ForwarderSet(_forwarder);
    }

    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        lastMetadata = metadata;
        lastReport = report;
        reportCount += 1;
        emit ReportReceived(msg.sender, reportCount, metadata, report);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }
}
