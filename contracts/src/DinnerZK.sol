// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Anonymous paid-guest ratings.
/// Groth16 membership proofs (Semaphore) are generated & verified in the guest's browser;
/// the chain stores the nullifier (one rating per identity) + an audit hash of the proof.
contract DinnerZK {
    uint256[] public commitments;
    mapping(uint256 => bool) public isMember;
    mapping(uint256 => bool) public spentNullifier;
    mapping(address => uint256) public ratingSum;
    mapping(address => uint256) public ratingCount;

    event Joined(uint256 commitment);
    event AnonRating(address indexed provider, uint256 rating, uint256 nullifier, bytes32 proofHash);

    function join(uint256 commitment) external {
        if (!isMember[commitment]) { isMember[commitment] = true; commitments.push(commitment); }
        emit Joined(commitment);
    }

    function memberCount() external view returns (uint256) { return commitments.length; }

    function rate(address provider, uint256 rating, uint256 nullifier, bytes32 proofHash) external {
        require(rating >= 1 && rating <= 5, "1-5");
        require(!spentNullifier[nullifier], "already rated");
        spentNullifier[nullifier] = true;
        ratingSum[provider] += rating;
        ratingCount[provider] += 1;
        emit AnonRating(provider, rating, nullifier, proofHash);
    }
}
