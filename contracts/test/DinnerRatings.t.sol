// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DinnerRatings, IDinnerNode} from "../src/DinnerRatings.sol";
import {ISemaphore} from "semaphore/packages/contracts/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreVerifier} from "semaphore/packages/contracts/contracts/interfaces/ISemaphoreVerifier.sol";
import {Semaphore} from "semaphore/packages/contracts/contracts/Semaphore.sol";
import {SemaphoreVerifier} from "semaphore/packages/contracts/contracts/base/SemaphoreVerifier.sol";

/// A stand-in for the deployed DinnerNode, so the join gate can be tested
/// against every job shape without opening real jobs.
contract NodeStub is IDinnerNode {
    mapping(uint256 => Job) private _jobs;

    function set(uint256 id, address requester, uint256 paid, bool open) external {
        // The middle fields carry non-zero values on purpose. They are what a
        // reader decoding this struct against v1's six-field shape would land
        // on, and `open` reading a rate is exactly the silent failure the
        // getJob switch exists to prevent.
        _jobs[id] = Job({
            requester: requester,
            provider: address(0xBEEF),
            escrow: 1 ether,
            paid: paid,
            tokens: 100,
            ratePerMillion: 26.7e18,
            maxTokensPerSecond: 400,
            openedAt: 1,
            lastSettleAt: 2,
            open: open,
            requireCheckpoints: true
        });
    }

    function getJob(uint256 id) external view returns (Job memory) {
        return _jobs[id];
    }
}

contract DinnerRatingsTest is Test {
    DinnerRatings ratings;
    Semaphore semaphore;
    NodeStub node;

    address guest = address(0xA11CE);
    address other = address(0xB0B);
    address provider = address(0xBEEF);

    function setUp() public {
        SemaphoreVerifier verifier = new SemaphoreVerifier();
        semaphore = new Semaphore(ISemaphoreVerifier(address(verifier)));
        node = new NodeStub();
        ratings = new DinnerRatings(ISemaphore(address(semaphore)), IDinnerNode(address(node)));
    }

    function _proof(uint256 rating, address p, uint256 nullifier)
        internal view returns (ISemaphore.SemaphoreProof memory)
    {
        return ISemaphore.SemaphoreProof({
            merkleTreeDepth: 1,
            merkleTreeRoot: semaphore.getMerkleTreeRoot(ratings.groupId()),
            nullifier: nullifier,
            message: rating,
            scope: uint256(uint160(p)),
            points: [uint256(1), 2, 3, 4, 5, 6, 7, 8]
        });
    }

    // ---- the join gate: this is what "paid guest" has to mean ----

    function test_join_requires_a_paid_closed_job_of_yours() public {
        node.set(1, guest, 5 ether, false);
        vm.prank(guest);
        ratings.join(1, 111);
        assertEq(ratings.memberCount(), 1);
        assertTrue(ratings.joinedWithJob(1));
    }

    function test_join_rejects_someone_elses_job() public {
        node.set(1, guest, 5 ether, false);
        vm.prank(other);
        vm.expectRevert(DinnerRatings.JobNotYours.selector);
        ratings.join(1, 111);
    }

    function test_join_rejects_an_open_job() public {
        node.set(1, guest, 5 ether, true);
        vm.prank(guest);
        vm.expectRevert(DinnerRatings.JobStillOpen.selector);
        ratings.join(1, 111);
    }

    function test_join_rejects_a_job_that_paid_nothing() public {
        node.set(1, guest, 0, false);
        vm.prank(guest);
        vm.expectRevert(DinnerRatings.JobUnpaid.selector);
        ratings.join(1, 111);
    }

    function test_one_job_buys_one_membership() public {
        node.set(1, guest, 5 ether, false);
        vm.startPrank(guest);
        ratings.join(1, 111);
        vm.expectRevert(DinnerRatings.JobAlreadyUsed.selector);
        ratings.join(1, 222);
        vm.stopPrank();
    }

    // ---- the property DinnerZK never had: a forged proof does not count ----

    function test_a_forged_proof_is_rejected_on_chain() public {
        node.set(1, guest, 5 ether, false);
        vm.prank(guest);
        ratings.join(1, 111);

        // Well-formed call, invented Groth16 points. DinnerZK would have
        // recorded this rating; Semaphore rejects it.
        //
        // The proof is built before expectRevert on purpose: _proof reads the
        // merkle root, and that external call would otherwise consume the
        // expectation and make this test pass without proving anything.
        ISemaphore.SemaphoreProof memory forged = _proof(5, provider, 999);
        vm.expectRevert();
        ratings.rate(provider, 5, forged);

        assertEq(ratings.ratingCount(provider), 0);
    }

    function test_rating_must_be_the_proof_message() public {
        ISemaphore.SemaphoreProof memory p = _proof(5, provider, 999);
        vm.expectRevert(DinnerRatings.RatingNotInProof.selector);
        ratings.rate(provider, 4, p); // relayer tries to downgrade the rating
    }

    function test_scope_must_be_the_provider() public {
        ISemaphore.SemaphoreProof memory p = _proof(5, provider, 999);
        vm.expectRevert(DinnerRatings.ScopeNotProvider.selector);
        ratings.rate(address(0xDEAD), 5, p); // relayer tries to move the rating
    }

    function test_rating_range_is_enforced_before_any_proof_work() public {
        ISemaphore.SemaphoreProof memory low = _proof(0, provider, 1);
        ISemaphore.SemaphoreProof memory high = _proof(6, provider, 2);
        vm.expectRevert(DinnerRatings.RatingOutOfRange.selector);
        ratings.rate(provider, 0, low);
        vm.expectRevert(DinnerRatings.RatingOutOfRange.selector);
        ratings.rate(provider, 6, high);
    }

    function test_group_is_readable_in_one_call() public {
        node.set(1, guest, 5 ether, false);
        node.set(2, other, 5 ether, false);
        vm.prank(guest);
        ratings.join(1, 111);
        vm.prank(other);
        ratings.join(2, 222);

        uint256[] memory all = ratings.allCommitments();
        assertEq(all.length, 2);
        assertEq(all[0], 111);
        assertEq(all[1], 222);
        assertEq(ratings.memberCount(), 2);
    }

    function test_average_is_zero_when_unrated() public view {
        assertEq(ratings.averageRating(provider), 0);
    }
}
