// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/DinnerNodeV2.sol";

/// One fixed EIP-712 vector, asserted on both sides of the wire.
///
/// The browser builds this digest with viem and the contract rebuilds it in
/// Solidity, and if the two ever disagree the failure is silent in the worst
/// way: every signature a guest gives is valid, and every handover that tries
/// to use one reverts with "bad auth" at 3am. So the same numbers are pinned
/// here and in web/src/lib/__tests__/reassign-auth.test.ts, and either side
/// drifting fails a test rather than a night.
contract DinnerNodeV2AuthVectorTest is Test {
    function test_the_pinned_vector() public {
        vm.chainId(10143);
        DinnerNodeV2 node = new DinnerNodeV2();
        bytes32 digest = node.reassignAuthDigest(42, address(0), 2, 1788000000);
        emit log_named_address("verifyingContract", address(node));
        emit log_named_uint("chainId", block.chainid);
        emit log_named_bytes32("digest", digest);
        assertEq(digest, VECTOR_DIGEST);
        assertEq(address(node), VECTOR_CONTRACT);
    }

    address constant VECTOR_CONTRACT = 0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f;
    bytes32 constant VECTOR_DIGEST = 0x72f3db480532f6bf9bbad04b1434a71ac2c8929c5e44742f44caa9197f6942f2;
}
