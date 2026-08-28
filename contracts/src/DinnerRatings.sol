// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISemaphore} from "semaphore/packages/contracts/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreGroups} from "semaphore/packages/contracts/contracts/interfaces/ISemaphoreGroups.sol";

/// @dev DinnerNodeV2's job accessor, and it must stay `getJob` rather than the
///      public `jobs` mapping. v2's Job has eleven fields where v1 had six, and
///      the positional tuple a mapping returns decodes wrong against the old
///      shape: `open` would read a rate, which is non-zero, so every closed job
///      would have passed the check below. `getJob` returns a single struct,
///      which cannot drift positionally at all.
///
///      Only the fields this contract reads are declared. The struct is
///      declared in full because a partial one would decode wrong for the same
///      reason the v1 interface did.
interface IDinnerNode {
    struct Job {
        address requester;
        address provider;
        uint256 escrow;
        uint256 paid;
        uint256 tokens;
        uint256 ratePerMillion;
        uint256 maxTokensPerSecond;
        uint64 openedAt;
        uint64 lastSettleAt;
        bool open;
        bool requireCheckpoints;
    }

    function getJob(uint256 jobId) external view returns (Job memory);
}

/// @notice Anonymous ratings from guests who actually paid for inference.
///
/// Replaces DinnerZK.sol, which took a `proofHash` and trusted it. Verifying a
/// Groth16 proof in the rater's own browser proves nothing to anyone else: the
/// browser is the party with the incentive to lie. Here the proof is verified
/// on chain by Semaphore, and the nullifier is tracked by Semaphore, so a
/// forged or replayed rating reverts rather than being recorded.
///
/// Two properties this contract does provide:
///
///  1. Only a guest who closed a job and paid for it can join the group, and a
///     given job buys exactly one membership. `DinnerZK.join` was open to
///     anyone, so "paid-guest ratings" was not enforced at all.
///  2. A rating proves membership without revealing which member sent it. The
///     nullifier is scoped to the provider, so one identity rates one provider
///     once and can still rate a different provider.
///
/// Two it does not, both of which have to be said out loud rather than implied:
///
///  a. `join` is called by the guest's own wallet, so the chain links that
///     wallet to its identity commitment. Anonymity therefore comes from the
///     size of the group and nothing else. In a group of one there is none.
///  b. `rate` is deliberately callable by anyone, so a rating can be relayed
///     and the guest's wallet need not appear. Whoever relays it learns the
///     rating and can correlate it by timing. That moves the trust rather than
///     removing it.
contract DinnerRatings {
    ISemaphore public immutable semaphore;
    IDinnerNode public immutable node;
    uint256 public immutable groupId;

    /// Every commitment ever added, in insertion order. The browser has to
    /// rebuild the group to generate a proof, and the Monad testnet RPC caps
    /// eth_getLogs at a 100 block range, so reconstructing membership from
    /// `Joined` events is not possible for a client. Keeping the list as state
    /// costs one SSTORE per join and makes the group readable in one call.
    uint256[] public commitments;

    mapping(uint256 => bool) public joinedWithJob;
    mapping(address => uint256) public ratingSum;
    mapping(address => uint256) public ratingCount;

    event Joined(uint256 indexed jobId, uint256 identityCommitment);
    event AnonRating(address indexed provider, uint256 rating, uint256 nullifier);

    error JobNotYours();
    error JobStillOpen();
    error JobUnpaid();
    error JobAlreadyUsed();
    error RatingOutOfRange();
    error RatingNotInProof();
    error ScopeNotProvider();

    constructor(ISemaphore _semaphore, IDinnerNode _node) {
        semaphore = _semaphore;
        node = _node;
        groupId = _semaphore.createGroup(address(this));
    }

    /// @notice Join the rating group using a job you paid for.
    /// @param jobId A closed job of yours with a non-zero `paid`.
    /// @param identityCommitment The Semaphore commitment, generated in the browser.
    function join(uint256 jobId, uint256 identityCommitment) external {
        IDinnerNode.Job memory j = node.getJob(jobId);
        if (j.requester != msg.sender) revert JobNotYours();
        if (j.open) revert JobStillOpen();
        if (j.paid == 0) revert JobUnpaid();
        if (joinedWithJob[jobId]) revert JobAlreadyUsed();

        joinedWithJob[jobId] = true;
        commitments.push(identityCommitment);
        semaphore.addMember(groupId, identityCommitment);

        emit Joined(jobId, identityCommitment);
    }

    /// @notice Rate a provider anonymously. Callable by anyone, including a relayer.
    /// @dev The rating is carried as the proof `message` and the provider as the
    ///      proof `scope`, so neither can be swapped in transit by whoever
    ///      relays the transaction. `validateProof` reverts on a bad proof, a
    ///      stale root or a spent nullifier.
    function rate(address provider, uint256 rating, ISemaphore.SemaphoreProof calldata proof) external {
        if (rating < 1 || rating > 5) revert RatingOutOfRange();
        if (proof.message != rating) revert RatingNotInProof();
        if (proof.scope != uint256(uint160(provider))) revert ScopeNotProvider();

        semaphore.validateProof(groupId, proof);

        ratingSum[provider] += rating;
        ratingCount[provider] += 1;

        emit AnonRating(provider, rating, proof.nullifier);
    }

    /// @notice Average rating in hundredths, so 437 means 4.37. Zero when unrated.
    function averageRating(address provider) external view returns (uint256) {
        uint256 c = ratingCount[provider];
        return c == 0 ? 0 : (ratingSum[provider] * 100) / c;
    }

    /// @notice The whole group, for a client that needs to rebuild the merkle
    ///         tree before it can prove membership in it.
    function allCommitments() external view returns (uint256[] memory) {
        return commitments;
    }

    function memberCount() external view returns (uint256) {
        return ISemaphoreGroups(address(semaphore)).getMerkleTreeSize(groupId);
    }
}
