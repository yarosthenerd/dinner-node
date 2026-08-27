// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/DinnerNodeV2.sol";

/// Plan commitments, and the one property they actually enforce.
///
/// The hash is a commitment for later audit and the contract cannot check that
/// the steps a provider ran are the steps in the plan. What it CAN do is stop
/// a job paying more than the ceiling the guest approved, and most of what is
/// below is about that boundary rather than about storage.
contract DinnerNodeV2PlanTest is Test {
    DinnerNodeV2 node;
    address guest = address(0xC1);
    address prov = address(0xB0B);

    bytes32 constant PLAN = keccak256("a plan");
    bytes32 constant PLAN2 = keccak256("a revised plan");

    // 1e18 wei per million tokens makes the arithmetic readable: one token is
    // 1e12 wei, so a 1 ether ceiling is exactly one million tokens.
    uint256 constant RATE = 1e18;
    uint256 constant TPS = 10_000;

    function setUp() public {
        node = new DinnerNodeV2();
        vm.prank(prov);
        node.registerProvider("m", "hw", RATE, TPS);
        vm.deal(guest, 100 ether);
    }

    function _job(uint256 budget) internal returns (uint256 id) {
        vm.startPrank(guest);
        node.deposit{value: budget}();
        // requireCheckpoints false: a plan run has no single growing prefix
        // to hash, so its ceiling comes from commitPlan rather than from
        // published progress. That is the whole point of this file.
        id = node.openJob(prov, budget, "tag", false);
        vm.stopPrank();
    }

    // Read through getJob, never by indexing the tuple. This file used to do
    // the latter and it is exactly the drift the struct getter exists to stop:
    // adding one field to Job silently shifted `open` under the old form.
    function _paid(uint256 id) internal view returns (uint256) {
        return node.getJob(id).paid;
    }

    function _open(uint256 id) internal view returns (bool) {
        return node.getJob(id).open;
    }

    // ---- storage and access ------------------------------------------------

    function test_commitStoresAndEmits() public {
        uint256 id = _job(1 ether);
        vm.expectEmit(true, true, false, true);
        emit DinnerNodeV2.PlanCommitted(id, PLAN, 1, 0.5 ether);
        vm.prank(guest);
        node.commitPlan(id, PLAN, 1, 0.5 ether);

        (bytes32 h, uint256 v, uint256 ceiling,) = node.plans(id);
        assertEq(h, PLAN);
        assertEq(v, 1);
        assertEq(ceiling, 0.5 ether);
    }

    function test_onlyRequesterMayCommit() public {
        uint256 id = _job(1 ether);
        // The provider is the party a ceiling constrains, so it must not be
        // able to set one.
        vm.prank(prov);
        vm.expectRevert("not your job");
        node.commitPlan(id, PLAN, 1, 0.5 ether);
    }

    function test_rejectsNonsense() public {
        uint256 id = _job(1 ether);
        vm.startPrank(guest);
        vm.expectRevert("empty plan");
        node.commitPlan(id, bytes32(0), 1, 0.5 ether);
        vm.expectRevert("zero version");
        node.commitPlan(id, PLAN, 0, 0.5 ether);
        vm.expectRevert("zero ceiling");
        node.commitPlan(id, PLAN, 1, 0);
        vm.expectRevert("ceiling over escrow");
        node.commitPlan(id, PLAN, 1, 2 ether);
        vm.stopPrank();
    }

    function test_versionsAreMonotonic() public {
        uint256 id = _job(1 ether);
        vm.startPrank(guest);
        node.commitPlan(id, PLAN, 2, 0.5 ether);
        vm.expectRevert("stale version");
        node.commitPlan(id, PLAN2, 2, 0.6 ether);
        vm.expectRevert("stale version");
        node.commitPlan(id, PLAN2, 1, 0.6 ether);
        // A revision is a new commitment, not an edit.
        node.commitPlan(id, PLAN2, 3, 0.6 ether);
        vm.stopPrank();
        (bytes32 h, uint256 v,,) = node.plans(id);
        assertEq(h, PLAN2);
        assertEq(v, 3);
    }

    function test_cannotCommitOnAClosedJob() public {
        uint256 id = _job(1 ether);
        vm.startPrank(guest);
        node.closeJob(id);
        vm.expectRevert("closed");
        node.commitPlan(id, PLAN, 1, 0.5 ether);
        vm.stopPrank();
    }

    // ---- the property that matters ----------------------------------------

    function test_settleStopsAtThePlanCeilingNotTheEscrow() public {
        uint256 id = _job(1 ether);
        vm.prank(guest);
        node.commitPlan(id, PLAN, 1, 0.25 ether); // a quarter of the escrow

        // Enough elapsed time that maxTokensPerSecond is not the binding cap.
        vm.warp(block.timestamp + 1000);
        vm.prank(prov);
        node.settle(id, 1_000_000); // worth 1 ether at RATE

        // Paid the ceiling, not the escrow.
        assertEq(_paid(id), 0.25 ether);
        // And still open, so the guest can raise the ceiling and continue.
        assertTrue(_open(id));
    }

    function test_withoutAPlanSettleStillUsesTheEscrow() public {
        uint256 id = _job(1 ether);
        vm.warp(block.timestamp + 1000);
        vm.prank(prov);
        node.settle(id, 1_000_000);
        assertEq(_paid(id), 1 ether);
        // An exhausted escrow announces itself and leaves the job OPEN. It used
        // to close here, in the same transaction that spent the last of it,
        // which meant topUp could never win the race and a guest who wanted to
        // continue lost the checkpoint chain. Leaving it open is inert: every
        // later settle pays zero, because remainingBudget is zero.
        assertTrue(_open(id));
    }

    function test_raisingTheCeilingLetsTheRunContinue() public {
        uint256 id = _job(1 ether);
        vm.startPrank(guest);
        node.commitPlan(id, PLAN, 1, 0.25 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 1000);
        vm.prank(prov);
        node.settle(id, 1_000_000);
        assertEq(_paid(id), 0.25 ether);

        // The guest approves a revision, which costs them a transaction. That
        // is the lazy-approval boundary made real.
        vm.prank(guest);
        node.commitPlan(id, PLAN2, 2, 0.75 ether);

        vm.warp(block.timestamp + 1000);
        vm.prank(prov);
        node.settle(id, 1_000_000);
        assertEq(_paid(id), 0.75 ether);
        assertTrue(_open(id));
    }

    function test_aRevisionCannotRetroactivelyCapPaidWork() public {
        uint256 id = _job(1 ether);
        vm.prank(guest);
        node.commitPlan(id, PLAN, 1, 0.5 ether);
        vm.warp(block.timestamp + 1000);
        vm.prank(prov);
        node.settle(id, 500_000); // 0.5 ether, the whole ceiling

        // Lowering the ceiling under work already paid for would make the
        // record say the provider was overpaid against an approved plan.
        vm.prank(guest);
        vm.expectRevert("ceiling below work already paid");
        node.commitPlan(id, PLAN2, 2, 0.4 ether);
    }

    function test_loweringTheCeilingAbovePaidWorkIsAllowed() public {
        uint256 id = _job(1 ether);
        vm.startPrank(guest);
        node.commitPlan(id, PLAN, 1, 0.9 ether);
        // A guest who decides the job is smaller than they thought may say so.
        node.commitPlan(id, PLAN2, 2, 0.3 ether);
        vm.stopPrank();
        vm.warp(block.timestamp + 1000);
        vm.prank(prov);
        node.settle(id, 1_000_000);
        assertEq(_paid(id), 0.3 ether);
    }

    function test_escrowStillBindsWhenTheCeilingIsHigher() public {
        // ceiling == escrow is legal, and the escrow remains the hard stop.
        uint256 id = _job(0.4 ether);
        vm.prank(guest);
        node.commitPlan(id, PLAN, 1, 0.4 ether);
        vm.warp(block.timestamp + 1000);
        vm.prank(prov);
        node.settle(id, 1_000_000);
        assertEq(_paid(id), 0.4 ether);
        assertTrue(_open(id)); // exhausted, not closed; see above
    }

    function test_planSurvivesManySettlesUnderTheCeiling() public {
        uint256 id = _job(1 ether);
        vm.prank(guest);
        node.commitPlan(id, PLAN, 1, 0.3 ether);
        for (uint256 i = 0; i < 5; i++) {
            vm.warp(block.timestamp + 100);
            vm.prank(prov);
            node.settle(id, 100_000); // 0.1 ether each
        }
        // Five settles worth 0.5 ether in total, capped at the 0.3 ceiling.
        assertEq(_paid(id), 0.3 ether);
        assertTrue(_open(id));
    }
}
