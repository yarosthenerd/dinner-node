// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/DinnerNodeV2.sol";

/// What a handover costs in gas, measured rather than assumed.
///
/// `src/host.ts` sizes the escrow it holds back for failover from
/// HANDOVER_GAS_UNITS. That was 320,000, a fallback limit nobody had measured,
/// until these tests and a live eth_estimateGas on 2026-09-22 set it to
/// 160,000 (D5 in .context/option1-claims.md).
///
/// Each case measures a whole transaction: execution with the contract's
/// storage cold, as it is at the start of a real transaction, plus the 21,000
/// base and the calldata. Monad reprices cold storage and account access above
/// Ethereum's, so these figures are the EVM floor. An eth_estimateGas against
/// the deployed contract is what confirms the Monad number.
contract DinnerNodeV2GasTest is Test {
    DinnerNodeV2 node;

    uint256 guestPk = 0xA11CE5;
    address guest;
    address alice = address(0xA11CE); // the provider the job opens against
    address bob = address(0xB0B);     // the standby that takes over
    address carol = address(0xCAC01); // a second standby

    /// HANDOVER_GAS_UNITS in host.ts. Every case below must fit under it, or
    /// the reserve is too small and a standby would refuse a job the serving
    /// node believed it had kept failoverable. Keep the two in step.
    uint256 constant ASSUMED = 160_000;

    function setUp() public {
        node = new DinnerNodeV2();
        guest = vm.addr(guestPk);
        // Live-shaped figures: 30 MON per million tokens, as node 1 charges.
        vm.prank(alice);
        node.registerProvider("m", "hw", 30 ether, 100);
        vm.prank(bob);
        node.registerProvider("m", "hw", 30 ether, 100);
        vm.prank(carol);
        node.registerProvider("m", "hw", 30 ether, 100);
        vm.deal(guest, 1000 ether);
        vm.warp(1_000_000);
    }

    function _job() internal returns (uint256 id) {
        vm.startPrank(guest);
        node.deposit{value: 1 ether}();
        id = node.openJob(alice, 1 ether, "tag", true);
        vm.stopPrank();
    }

    function _sign(uint256 jobId, address newProvider, uint256 maxReassigns, uint64 deadline)
        internal view returns (bytes memory)
    {
        bytes32 digest = node.reassignAuthDigest(jobId, newProvider, maxReassigns, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(guestPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// The outgoing provider has served and published, which is the state a
    /// real handover finds and the one that makes _reassign settle it out.
    function _served(uint256 id) internal {
        vm.warp(block.timestamp + 60);
        vm.prank(alice);
        node.settle(id, 1_000, keccak256("prefix"), 1_000, 1_000);
        vm.warp(block.timestamp + 60);
    }

    /// 21,000 plus calldata at 16 gas a nonzero byte and 4 a zero byte.
    function _intrinsic(bytes memory data) internal pure returns (uint256 g) {
        g = 21_000;
        for (uint256 i = 0; i < data.length; i++) g += data[i] == 0 ? 4 : 16;
    }

    function _handover(uint256 id, address to, uint256 maxReassigns, bytes memory auth, uint64 deadline)
        internal returns (uint256)
    {
        bytes memory data = abi.encodeCall(node.reassignWithAuth, (id, to, maxReassigns, deadline, auth));
        vm.cool(address(node));
        vm.prank(to);
        uint256 before = gasleft();
        node.reassignWithAuth(id, to, maxReassigns, deadline, auth);
        uint256 exec = before - gasleft();
        assertEq(node.getJob(id).provider, to);
        return exec + _intrinsic(data);
    }

    /// The path the site uses: a wildcard signature, one recover.
    function test_gas_wildcard_first_handover() public {
        uint256 id = _job();
        _served(id);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        uint256 g = _handover(id, bob, 2, _sign(id, address(0), 2, deadline), deadline);
        console.log("reassignWithAuth, wildcard, first handover:", g);
        assertLt(g, ASSUMED);
    }

    /// A signature naming the standby costs a second recover, because the
    /// wildcard digest is tried first and fails.
    function test_gas_named_first_handover() public {
        uint256 id = _job();
        _served(id);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        uint256 g = _handover(id, bob, 2, _sign(id, bob, 2, deadline), deadline);
        console.log("reassignWithAuth, named, first handover:", g);
        assertLt(g, ASSUMED);
    }

    /// The second handover on a job writes to slots the first already made
    /// nonzero, so it should be the cheaper of the two.
    function test_gas_wildcard_second_handover() public {
        uint256 id = _job();
        _served(id);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(id, address(0), 2, deadline);
        _handover(id, bob, 2, auth, deadline);
        vm.warp(block.timestamp + 60);
        vm.prank(bob);
        node.settle(id, 1_000, keccak256("prefix2"), 2_000, 2_000);
        vm.warp(block.timestamp + 60);
        uint256 g = _handover(id, carol, 2, auth, deadline);
        console.log("reassignWithAuth, wildcard, second handover:", g);
        assertLt(g, ASSUMED);
    }
}
