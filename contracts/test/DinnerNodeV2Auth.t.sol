// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/DinnerNodeV2.sol";

/// reassignWithAuth: the signed authorisation that lets a job move providers
/// while the guest is asleep.
///
/// Written as the attacks rather than as the feature. Every test that is not
/// the happy path is somebody trying to use a signature for something the
/// guest did not agree to, and asserts either the revert or the money.
contract DinnerNodeV2AuthTest is Test {
    DinnerNodeV2 node;

    uint256 guestPk = 0xA11CE5;
    address guest;
    address alice = address(0xA11CE); // the provider the job opens against
    address bob = address(0xB0B);     // the standby that takes over
    address carol = address(0xCAC01); // a third registered provider
    address mallory = address(0xBAD);  // registered, and not party to the job

    uint256 constant RATE = 1e18;
    uint256 constant SLOW = 100;
    uint256 constant FAST = 10_000;

    function setUp() public {
        node = new DinnerNodeV2();
        guest = vm.addr(guestPk);
        vm.prank(alice);
        node.registerProvider("m", "hw", RATE, SLOW);
        vm.prank(bob);
        node.registerProvider("m", "hw", RATE, SLOW);
        vm.prank(carol);
        node.registerProvider("m", "hw", RATE, SLOW);
        vm.prank(mallory);
        node.registerProvider("m", "hw", RATE, SLOW);
        vm.deal(guest, 1000 ether);
        vm.warp(1_000_000);
    }

    function _job(uint256 budget) internal returns (uint256 id) {
        vm.startPrank(guest);
        node.deposit{value: budget}();
        id = node.openJob(alice, budget, "tag", true);
        vm.stopPrank();
    }

    function _cp(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("prefix", n));
    }

    /// The guest signs at order time. `newProvider` zero is the wildcard the
    /// client actually uses, because it does not yet know which standby will
    /// still be alive when the first one dies.
    function _sign(uint256 pk, uint256 jobId, address newProvider, uint256 maxReassigns, uint64 deadline)
        internal view returns (bytes memory)
    {
        bytes32 digest = node.reassignAuthDigest(jobId, newProvider, maxReassigns, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ---- the happy path ----------------------------------------------------

    function test_a_standby_takes_the_job_with_no_guest_transaction() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 2, deadline);

        // Alice serves and publishes, then goes dark.
        vm.warp(block.timestamp + 1000);
        vm.prank(alice);
        node.settle(id, 100_000, _cp(100_000), 100_000, 100_000);

        // Bob submits the guest's signature himself. The guest sends nothing.
        vm.prank(bob);
        node.reassignWithAuth(id, bob, 2, deadline, auth);

        assertEq(node.getJob(id).provider, bob);
        assertEq(node.reassignCount(id), 1);
        // And Bob is still bound by the published-progress clamp: he is paid
        // for what he adds, not for the prefix he inherited.
        vm.warp(block.timestamp + 1000);
        vm.prank(bob);
        node.settle(id, 120_000, _cp(120_000), 120_000, 120_000);
        assertEq(node.getJob(id).tokens, 120_000);
        assertEq(node.getJob(id).paid, 0.12 ether);
    }

    function test_the_outgoing_provider_is_settled_for_what_it_published() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 1, deadline);

        // Alice publishes a checkpoint without settling, then dies.
        vm.warp(block.timestamp + 1000);
        vm.prank(alice);
        node.commitCheckpoint(id, _cp(50_000), 50_000, 50_000);

        vm.prank(bob);
        node.reassignWithAuth(id, bob, 1, deadline, auth);

        // Paid for exactly the 50,000 she published, by the same rule the
        // guest-signed reassign uses.
        assertEq(node.getProvider(alice).earned, 0.05 ether);
        assertEq(node.getJob(id).tokens, 50_000);
    }

    function test_a_named_authorisation_works_for_that_provider() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, bob, 1, deadline);

        vm.prank(bob);
        node.reassignWithAuth(id, bob, 1, deadline, auth);
        assertEq(node.getJob(id).provider, bob);
    }

    // ---- what the signature cannot be used for -----------------------------

    function test_a_provider_the_guest_did_not_name_cannot_use_a_named_auth() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        // The guest authorised BOB and nobody else.
        bytes memory auth = _sign(guestPk, id, bob, 1, deadline);

        vm.prank(carol);
        vm.expectRevert("bad auth");
        node.reassignWithAuth(id, carol, 1, deadline, auth);
    }

    function test_a_third_party_cannot_move_someone_elses_job() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 1, deadline);

        // Mallory holds a valid wildcard signature and tries to hand the job
        // to Bob. Only the node actually taking the work may submit.
        vm.prank(mallory);
        vm.expectRevert("not the new provider");
        node.reassignWithAuth(id, bob, 1, deadline, auth);
    }

    function test_an_expired_authorisation_is_refused() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 1, deadline);

        vm.warp(block.timestamp + 2 hours);
        vm.prank(bob);
        vm.expectRevert("auth expired");
        node.reassignWithAuth(id, bob, 1, deadline, auth);
    }

    function test_one_signature_does_not_buy_unlimited_handovers() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 1, deadline);

        vm.prank(bob);
        node.reassignWithAuth(id, bob, 1, deadline, auth);

        // The same signature, replayed by the next standby in line.
        vm.prank(carol);
        vm.expectRevert("auth spent");
        node.reassignWithAuth(id, carol, 1, deadline, auth);
    }

    function test_maxReassigns_two_allows_exactly_two() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 2, deadline);

        vm.prank(bob);
        node.reassignWithAuth(id, bob, 2, deadline, auth);
        vm.prank(carol);
        node.reassignWithAuth(id, carol, 2, deadline, auth);
        assertEq(node.getJob(id).provider, carol);
        assertEq(node.reassignCount(id), 2);

        vm.prank(mallory);
        vm.expectRevert("auth spent");
        node.reassignWithAuth(id, mallory, 2, deadline, auth);
    }

    function test_the_caller_cannot_raise_maxReassigns_on_its_own() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        // Signed for one handover. Bob submits claiming five, which changes
        // the digest and therefore fails to recover the guest.
        bytes memory auth = _sign(guestPk, id, address(0), 1, deadline);

        vm.prank(bob);
        vm.expectRevert("bad auth");
        node.reassignWithAuth(id, bob, 5, deadline, auth);
    }

    function test_the_caller_cannot_extend_the_deadline_on_its_own() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 1, deadline);

        vm.prank(bob);
        vm.expectRevert("bad auth");
        node.reassignWithAuth(id, bob, 1, deadline + 1 days, auth);
    }

    function test_an_authorisation_for_one_job_cannot_move_another() public {
        uint256 a = _job(10 ether);
        uint256 b = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, a, address(0), 1, deadline);

        vm.prank(bob);
        vm.expectRevert("bad auth");
        node.reassignWithAuth(b, bob, 1, deadline, auth);
    }

    function test_someone_elses_signature_is_not_the_requesters() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        // Mallory signs an authorisation for a job that is not hers.
        bytes memory auth = _sign(0xBADBAD, id, address(0), 1, deadline);

        vm.prank(bob);
        vm.expectRevert("bad auth");
        node.reassignWithAuth(id, bob, 1, deadline, auth);
    }

    function test_a_closed_job_cannot_be_reassigned() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 1, deadline);

        vm.prank(guest);
        node.closeJob(id);

        vm.prank(bob);
        vm.expectRevert("closed");
        node.reassignWithAuth(id, bob, 1, deadline, auth);
    }

    function test_an_inactive_provider_cannot_take_the_job() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 1, deadline);

        vm.prank(bob);
        node.deregisterProvider();

        vm.prank(bob);
        vm.expectRevert("inactive provider");
        node.reassignWithAuth(id, bob, 1, deadline, auth);
    }

    function test_the_current_provider_cannot_hand_the_job_to_itself() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 1, deadline);

        vm.prank(alice);
        vm.expectRevert("same provider");
        node.reassignWithAuth(id, alice, 1, deadline, auth);
    }

    // ---- the bounds that make the wildcard safe to sign --------------------

    function test_a_replacement_cannot_raise_the_rate_it_is_paid() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 1, deadline);

        // Bob re-registers at ten times the rate the guest agreed to, then
        // takes the job with the guest's own signature.
        vm.prank(bob);
        node.registerProvider("m", "hw", RATE * 10, SLOW);
        vm.prank(bob);
        node.reassignWithAuth(id, bob, 1, deadline, auth);

        assertEq(node.getJob(id).ratePerMillion, RATE);
        vm.warp(block.timestamp + 1000);
        vm.prank(bob);
        node.settle(id, 100_000, _cp(100_000), 100_000, 100_000);
        // Paid at the job's locked rate, not at Bob's new one.
        assertEq(node.getJob(id).paid, 0.1 ether);
    }

    function test_a_replacement_cannot_raise_the_throughput_ceiling() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 1, deadline);

        vm.prank(bob);
        node.registerProvider("m", "hw", RATE, FAST);
        vm.prank(bob);
        node.reassignWithAuth(id, bob, 1, deadline, auth);

        assertEq(node.getJob(id).maxTokensPerSecond, SLOW);
    }

    function test_a_replacement_that_publishes_nothing_is_paid_nothing() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 2, deadline);

        // Alice never published, so she leaves with nothing.
        vm.warp(block.timestamp + 1000);
        vm.prank(bob);
        node.reassignWithAuth(id, bob, 2, deadline, auth);
        assertEq(node.getProvider(alice).earned, 0);

        // Bob does the same to Carol, and is paid nothing for the same reason.
        vm.warp(block.timestamp + 1000);
        vm.prank(carol);
        node.reassignWithAuth(id, carol, 2, deadline, auth);
        assertEq(node.getProvider(bob).earned, 0);
        assertEq(node.getJob(id).paid, 0);
    }

    // ---- replay across deployments and chains ------------------------------

    function test_a_signature_does_not_replay_on_another_chain() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 1, deadline);

        // Same contract address, same job id, a forked chain.
        vm.chainId(block.chainid + 1);
        vm.prank(bob);
        vm.expectRevert("bad auth");
        node.reassignWithAuth(id, bob, 1, deadline, auth);
    }

    function test_a_signature_does_not_replay_on_another_deployment() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes memory auth = _sign(guestPk, id, address(0), 1, deadline);

        DinnerNodeV2 twin = new DinnerNodeV2();
        vm.prank(alice);
        twin.registerProvider("m", "hw", RATE, SLOW);
        vm.prank(bob);
        twin.registerProvider("m", "hw", RATE, SLOW);
        vm.startPrank(guest);
        twin.deposit{value: 10 ether}();
        uint256 twinJob = twin.openJob(alice, 10 ether, "tag", true);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert("bad auth");
        twin.reassignWithAuth(twinJob, bob, 1, deadline, auth);
    }

    function test_a_malleable_signature_is_refused() public {
        uint256 id = _job(10 ether);
        uint64 deadline = uint64(block.timestamp + 8 hours);
        bytes32 digest = node.reassignAuthDigest(id, address(0), 1, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(guestPk, digest);

        // The other valid (r, s, v) for the same key and digest.
        uint256 N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 flipped = bytes32(N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        vm.prank(bob);
        vm.expectRevert();
        node.reassignWithAuth(id, bob, 1, deadline, abi.encodePacked(r, flipped, flippedV));
    }

    // ---- the guest keeps the authority they always had ---------------------

    function test_the_guest_can_still_reassign_by_hand() public {
        uint256 id = _job(10 ether);
        vm.prank(guest);
        node.reassign(id, bob);
        assertEq(node.getJob(id).provider, bob);
        // The hand path does not spend an authorisation.
        assertEq(node.reassignCount(id), 0);
    }

    function test_a_provider_still_cannot_reassign_without_a_signature() public {
        uint256 id = _job(10 ether);
        vm.prank(bob);
        vm.expectRevert("not requester");
        node.reassign(id, bob);
    }
}
