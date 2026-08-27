// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/DinnerNodeV2.sol";

/// The seven defects that gated a v2 deploy, one section each.
///
/// Every test here fails against the version of DinnerNodeV2.sol that carried
/// commitPlan and nothing else. They are written as the attack, not as the
/// fix: each one does the thing a guest or a provider could actually do, and
/// asserts the money that changes hands.
contract DinnerNodeV2DefectsTest is Test {
    DinnerNodeV2 node;
    address guest = address(0xC1);
    address alice = address(0xA11CE); // the first provider
    address bob = address(0xB0B);     // the replacement

    // 1e18 wei per million makes one token exactly 1e12 wei, so a 1 ether
    // escrow is exactly one million tokens.
    uint256 constant RATE = 1e18;
    uint256 constant SLOW = 100;    // tokens per second, a realistic node
    uint256 constant FAST = 10_000; // the contract's ceiling

    function setUp() public {
        node = new DinnerNodeV2();
        vm.prank(alice);
        node.registerProvider("m", "hw", RATE, SLOW);
        vm.prank(bob);
        node.registerProvider("m", "hw", RATE, FAST);
        vm.deal(guest, 1000 ether);
        vm.deal(alice, 1000 ether);
        // Start well clear of zero so `elapsed` arithmetic is never near an
        // underflow and warps read naturally.
        vm.warp(1_000_000);
    }

    function _job(uint256 budget, bool requireCp) internal returns (uint256 id) {
        vm.startPrank(guest);
        node.deposit{value: budget}();
        id = node.openJob(alice, budget, "tag", requireCp);
        vm.stopPrank();
    }

    /// A checkpoint for `visible` visible tokens and `billed` billable ones.
    function _cp(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("prefix", n));
    }

    // ---- 1. settle is clamped to published progress ------------------------

    function test_1_a_replacement_cannot_be_paid_for_the_prefix_it_inherited() public {
        uint256 id = _job(10 ether, true);

        // Alice serves 100,000 tokens over 1000s and settles, publishing the
        // checkpoint that evidences them.
        vm.warp(block.timestamp + 1000);
        vm.prank(alice);
        node.settle(id, 100_000, _cp(100_000), 100_000, 100_000);
        assertEq(node.getJob(id).paid, 0.1 ether);
        assertEq(node.getJob(id).tokens, 100_000);

        // The guest hands the job to Bob, who resumes from the checkpoint and
        // produces 20,000 more. Bob then tries to bill for the WHOLE answer.
        vm.prank(guest);
        node.reassign(id, bob);
        vm.warp(block.timestamp + 1000);
        vm.prank(bob);
        node.settle(id, 120_000, _cp(120_000), 120_000, 120_000);

        // Bob is paid for his 20,000 and not one token more. Without the
        // published-progress clamp he would have taken 120,000, and the guest
        // would have paid for Alice's prefix twice.
        assertEq(node.getJob(id).tokens, 120_000);
        assertEq(node.getJob(id).paid, 0.12 ether);
    }

    function test_1_b_a_provider_cannot_outrun_its_own_checkpoints() public {
        uint256 id = _job(10 ether, true);
        vm.warp(block.timestamp + 1000);
        // Claims 90,000 tokens while publishing evidence of only 10,000.
        vm.prank(alice);
        node.settle(id, 90_000, _cp(1), 10_000, 10_000);
        assertEq(node.getJob(id).tokens, 10_000);
        assertEq(node.getJob(id).paid, 0.01 ether);
    }

    function test_1_c_a_job_that_requires_checkpoints_refuses_a_bare_settle() public {
        uint256 id = _job(10 ether, true);
        vm.warp(block.timestamp + 1000);
        vm.prank(alice);
        vm.expectRevert("checkpoint required");
        node.settle(id, 100_000);
    }

    function test_1_d_a_plan_job_may_still_settle_without_one() public {
        // The escape hatch, and the reason requireCheckpoints is the guest's
        // choice: a plan run has no single growing prefix to hash.
        uint256 id = _job(10 ether, false);
        vm.warp(block.timestamp + 1000);
        vm.prank(alice);
        node.settle(id, 100_000);
        assertEq(node.getJob(id).paid, 0.1 ether);
    }

    // ---- 2. reassign cannot strand the outgoing provider -------------------

    function test_2_reassign_pays_out_the_work_it_takes_away() public {
        uint256 id = _job(10 ether, true);

        // Alice streams for 500s and publishes checkpoints as she goes, but has
        // not reached her settle threshold yet. The guest reassigns at exactly
        // the moment that maximises what he takes for free.
        vm.warp(block.timestamp + 500);
        vm.prank(alice);
        node.commitCheckpoint(id, _cp(50_000), 50_000, 50_000);

        assertEq(node.getJob(id).paid, 0);
        vm.prank(guest);
        node.reassign(id, bob);

        // Alice is paid for the 50,000 tokens she published. Before this fix
        // she was paid nothing, repeatably, for the price of one transaction.
        assertEq(node.getJob(id).paid, 0.05 ether);
        assertEq(node.getProvider(alice).earned, 0.05 ether);
        assertEq(node.getJob(id).provider, bob);
    }

    function test_2_b_the_payout_is_bounded_exactly_as_a_settle_would_be() public {
        uint256 id = _job(10 ether, true);
        // Alice publishes a checkpoint claiming far more than her declared
        // throughput could have produced in the elapsed time.
        vm.warp(block.timestamp + 10);
        vm.prank(alice);
        node.commitCheckpoint(id, _cp(999_999), 999_999, 999_999);
        vm.prank(guest);
        node.reassign(id, bob);
        // 10 seconds at 100 tok/s is 1,000 tokens. Reassign is not a way round
        // the throughput bound.
        assertEq(node.getJob(id).tokens, 1_000);
        assertEq(node.getJob(id).paid, 0.001 ether);
    }

    function test_2_c_a_provider_that_published_nothing_is_owed_nothing() public {
        uint256 id = _job(10 ether, true);
        vm.warp(block.timestamp + 500);
        vm.prank(guest);
        node.reassign(id, bob);
        assertEq(node.getJob(id).paid, 0);
        assertEq(node.getProvider(alice).earned, 0);
    }

    // ---- 3. reassign cannot raise the throughput ceiling -------------------

    function test_3_reassign_never_raises_maxTokensPerSecond() public {
        // The job locked Alice's 100 tok/s. Bob declares 10,000.
        uint256 id = _job(10 ether, true);
        assertEq(node.getJob(id).maxTokensPerSecond, SLOW);

        vm.prank(guest);
        node.reassign(id, bob);
        assertEq(node.getJob(id).maxTokensPerSecond, SLOW);

        // And the bound actually binds: 100s at the LOCKED 100 tok/s is 10,000
        // tokens, not the 1,000,000 Bob's own figure would have allowed.
        vm.warp(block.timestamp + 100);
        vm.prank(bob);
        node.settle(id, 1_000_000, _cp(1), 1_000_000, 1_000_000);
        assertEq(node.getJob(id).tokens, 10_000);
    }

    function test_3_b_reassign_does_lower_it_when_the_replacement_is_slower() public {
        address slowpoke = address(0x5100);
        vm.prank(slowpoke);
        node.registerProvider("m", "hw", RATE, 10);
        // Open against fast Bob so there is room to fall.
        vm.startPrank(guest);
        node.deposit{value: 10 ether}();
        uint256 id = node.openJob(bob, 10 ether, "tag", true);
        node.reassign(id, slowpoke);
        vm.stopPrank();
        assertEq(node.getJob(id).maxTokensPerSecond, 10);
    }

    // ---- 4. checkpoints advance, and they chain ----------------------------

    function test_4_a_same_height_rewrite_is_refused() public {
        uint256 id = _job(10 ether, true);
        vm.startPrank(alice);
        node.commitCheckpoint(id, _cp(1), 100, 100);
        // The old guard was `tokens >= cp.tokens`, so this succeeded and the
        // record of what was produced became whatever was written last.
        vm.expectRevert("checkpoint must advance");
        node.commitCheckpoint(id, _cp(2), 100, 100);
        vm.stopPrank();
        assertEq(node.getCheckpoint(id).prefixHash, _cp(1));
    }

    function test_4_b_going_backwards_is_refused() public {
        uint256 id = _job(10 ether, true);
        vm.startPrank(alice);
        node.commitCheckpoint(id, _cp(1), 100, 100);
        vm.expectRevert("checkpoint must advance");
        node.commitCheckpoint(id, _cp(2), 50, 200);
        vm.stopPrank();
    }

    function test_4_c_billed_may_never_sit_below_visible() public {
        uint256 id = _job(10 ether, true);
        vm.prank(alice);
        vm.expectRevert("billed below visible");
        // Every visible token is also a billed one, so this is incoherent.
        node.commitCheckpoint(id, _cp(1), 100, 99);
    }

    function test_4_d_the_chain_covers_the_whole_history() public {
        uint256 id = _job(10 ether, true);
        vm.startPrank(alice);
        node.commitCheckpoint(id, _cp(1), 100, 150);
        bytes32 first = node.getCheckpoint(id).chainHash;
        node.commitCheckpoint(id, _cp(2), 200, 300);
        vm.stopPrank();

        // Recomputable by anyone who kept the frames, which is what makes it
        // evidence rather than a number the provider asserts.
        assertEq(first, keccak256(abi.encode(bytes32(0), _cp(1), uint256(100), uint256(150), alice)));
        assertEq(
            node.getCheckpoint(id).chainHash,
            keccak256(abi.encode(first, _cp(2), uint256(200), uint256(300), alice))
        );
    }

    function test_4_e_reasoning_stays_billable_above_the_visible_prefix() public {
        // The property the two counts exist to preserve. 100 visible tokens
        // and 300 billable: the guest is charged for all 300, and the hash
        // still covers exactly the 100 a replacement would be handed.
        uint256 id = _job(10 ether, true);
        vm.warp(block.timestamp + 1000);
        vm.prank(alice);
        node.settle(id, 300, _cp(1), 100, 300);
        assertEq(node.getJob(id).tokens, 300);
        assertEq(node.getCheckpoint(id).tokens, 100);
    }

    // ---- 5. reputation counters ignore self-dealing ------------------------

    function test_5_a_provider_paying_itself_earns_no_reputation() public {
        // Alice is both requester and provider: the MON goes round in a circle
        // and only gas is spent, but tokensServed used to climb, and discovery
        // sorts on tokensServed.
        vm.startPrank(alice);
        node.deposit{value: 10 ether}();
        uint256 id = node.openJob(alice, 10 ether, "tag", false);
        vm.warp(block.timestamp + 1000);
        node.settle(id, 100_000);
        vm.stopPrank();

        DinnerNodeV2.Provider memory p = node.getProvider(alice);
        assertEq(p.tokensServed, 0);
        assertEq(p.lifetimeEarned, 0);
        assertEq(p.jobs, 0);
        // The balance is real money and still accrues; it came out of Alice's
        // own deposit and is hers to withdraw.
        assertEq(p.earned, 0.1 ether);
    }

    function test_5_b_arms_length_work_counts_normally() public {
        uint256 id = _job(10 ether, false);
        vm.warp(block.timestamp + 1000);
        vm.prank(alice);
        node.settle(id, 100_000);

        DinnerNodeV2.Provider memory p = node.getProvider(alice);
        assertEq(p.tokensServed, 100_000);
        assertEq(p.lifetimeEarned, 0.1 ether);
        assertEq(p.jobs, 1);
    }

    function test_5_c_reputation_counts_clamped_tokens_not_claimed_ones() public {
        uint256 id = _job(10 ether, false);
        vm.warp(block.timestamp + 10); // 10s x 100 tok/s = 1,000 allowed
        vm.prank(alice);
        node.settle(id, 5_000_000);
        // Inflating the claim inflates nothing: the counter takes what the
        // bounds allowed, which is the same figure the guest paid for.
        assertEq(node.getProvider(alice).tokensServed, 1_000);
    }

    // ---- 6. topUp can rescue an exhausted job ------------------------------

    function test_6_topUp_revives_a_job_whose_escrow_ran_out() public {
        uint256 id = _job(0.1 ether, false); // 100,000 tokens' worth
        vm.warp(block.timestamp + 10_000);
        vm.prank(alice);
        node.settle(id, 100_000);
        assertEq(node.getJob(id).paid, 0.1 ether);

        // The whole defect: this used to revert with "closed", because settle
        // shut the job in the same transaction that spent the last of it.
        assertTrue(node.getJob(id).open);
        vm.startPrank(guest);
        node.deposit{value: 0.1 ether}();
        node.topUp(id, 0.1 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 10_000);
        vm.prank(alice);
        node.settle(id, 100_000);
        assertEq(node.getJob(id).paid, 0.2 ether);
        assertEq(node.getJob(id).tokens, 200_000);
    }

    function test_6_b_exhaustion_announces_itself() public {
        uint256 id = _job(0.1 ether, false);
        vm.warp(block.timestamp + 10_000);
        vm.expectEmit(true, false, false, true);
        emit DinnerNodeV2.JobExhausted(id, 100_000, 0.1 ether);
        vm.prank(alice);
        node.settle(id, 100_000);
    }

    function test_6_c_an_exhausted_job_pays_nothing_while_it_waits() public {
        // Leaving it open has to be inert, or the fix would be a hole.
        uint256 id = _job(0.1 ether, false);
        vm.warp(block.timestamp + 10_000);
        vm.prank(alice);
        node.settle(id, 100_000);
        vm.warp(block.timestamp + 10_000);
        vm.prank(alice);
        node.settle(id, 100_000);
        assertEq(node.getJob(id).paid, 0.1 ether);
    }

    function test_6_d_closing_an_exhausted_job_refunds_nothing_and_still_works() public {
        uint256 id = _job(0.1 ether, false);
        vm.warp(block.timestamp + 10_000);
        vm.prank(alice);
        node.settle(id, 100_000);
        vm.prank(alice);
        node.closeJob(id);
        assertFalse(node.getJob(id).open);
        assertEq(node.deposits(guest), 0);
    }

    // ---- 7. struct reads, so index drift cannot happen ---------------------

    function test_7_getJob_returns_named_fields() public {
        uint256 id = _job(1 ether, true);
        DinnerNodeV2.Job memory j = node.getJob(id);
        // The exact confusion the getter exists to prevent: `open` and
        // `ratePerMillion` are both truthy here, and under positional decoding
        // a client written against v1 read the rate where open should be.
        assertEq(j.requester, guest);
        assertEq(j.provider, alice);
        assertEq(j.escrow, 1 ether);
        assertEq(j.ratePerMillion, RATE);
        assertEq(j.maxTokensPerSecond, SLOW);
        assertTrue(j.open);
        assertTrue(j.requireCheckpoints);
    }

    function test_7_b_getProvider_returns_named_fields() public {
        DinnerNodeV2.Provider memory p = node.getProvider(alice);
        assertEq(p.ratePerMillion, RATE);
        assertEq(p.maxTokensPerSecond, SLOW);
        assertTrue(p.active);
    }

    function test_7_c_remainingBudget_is_the_number_a_client_should_show() public {
        uint256 id = _job(1 ether, false);
        assertEq(node.remainingBudget(id), 1 ether);
        vm.prank(guest);
        node.commitPlan(id, keccak256("p"), 1, 0.3 ether);
        // The plan ceiling binds below the escrow, and the client no longer has
        // to know that rule to display it.
        assertEq(node.remainingBudget(id), 0.3 ether);
    }

    // ---- the promise the whole contract is for -----------------------------

    function test_worst_case_loss_is_one_settlement_interval() public {
        // The README's claim, as an assertion. A malicious provider on a job
        // with a large escrow takes, at most, its declared throughput times
        // the time since the last settlement, whatever it asks for.
        uint256 id = _job(100 ether, true);
        vm.warp(block.timestamp + 3); // three seconds since open
        vm.prank(alice);
        node.settle(id, type(uint256).max, _cp(1), 10_000_000, 10_000_000);
        // 3s x 100 tok/s = 300 tokens = 0.0003 ether. Not the 100 ether escrow.
        assertEq(node.getJob(id).tokens, 300);
        assertEq(node.getJob(id).paid, 0.0003 ether);
    }
}
