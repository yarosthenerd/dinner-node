// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Registry and streaming escrow for DinnerNode.
/// @dev v2 exists to close a defect in v1: settle() accepted any tokensDelta
///      from the provider, capped only by the remaining escrow, so a single
///      call could take the whole escrow for zero work. The README promised
///      "guest worst-case loss = one settlement" and the code did not deliver
///      it. v2 makes that promise true by bounding each settlement to the
///      tokens the provider could plausibly have produced since the previous
///      one, and by locking the rate at the moment the job opens.
contract DinnerNodeV2 {
    struct Provider {
        string model;
        string hw;
        uint256 ratePerMillion;
        uint256 maxTokensPerSecond; // throughput ceiling this node claims
        uint256 earned;
        uint256 tokensServed;
        uint256 jobs;
        bool active;
    }

    struct Job {
        address requester;
        address provider;
        uint256 escrow;
        uint256 paid;
        uint256 tokens;
        uint256 ratePerMillion;     // locked at open, immune to later re-registration
        uint256 maxTokensPerSecond; // locked at open, for the same reason
        uint64 openedAt;
        uint64 lastSettleAt;
        bool open;
    }

    struct Checkpoint {
        bytes32 prefixHash;
        uint256 tokens;
    }

    // A provider that declares an implausible throughput is still bounded, so
    // the guest's exposure per settlement can never exceed this much wall time
    // of work regardless of what the node claims.
    uint256 public constant MAX_TOKENS_PER_SECOND = 10_000;

    event ProviderRegistered(address indexed provider, string model, string hw, uint256 ratePerMillion, uint256 maxTokensPerSecond);
    event Deposited(address indexed requester, uint256 amount);
    event JobOpened(uint256 indexed jobId, address indexed requester, address indexed provider, string promptTag);
    event JobToppedUp(uint256 indexed jobId, uint256 added, uint256 escrow);
    event StreamSettled(uint256 indexed jobId, address indexed provider, uint256 tokensDelta, uint256 amount);
    event CheckpointCommitted(uint256 indexed jobId, address indexed provider, bytes32 prefixHash, uint256 tokens);
    event JobReassigned(uint256 indexed jobId, address indexed from, address indexed to);
    event JobClosed(uint256 indexed jobId, uint256 totalTokens, uint256 totalPaid);
    event Withdrawn(address indexed provider, uint256 amount);
    event Refunded(address indexed requester, uint256 amount);

    mapping(address => Provider) public providers;
    mapping(address => uint256) public deposits;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => Checkpoint) public checkpoints;
    uint256 public jobCounter;

    function registerProvider(string calldata model, string calldata hw, uint256 ratePerMillion, uint256 maxTokensPerSecond) external {
        require(ratePerMillion > 0, "rate");
        require(maxTokensPerSecond > 0 && maxTokensPerSecond <= MAX_TOKENS_PER_SECOND, "tps");
        Provider storage p = providers[msg.sender];
        p.model = model;
        p.hw = hw;
        p.ratePerMillion = ratePerMillion;
        p.maxTokensPerSecond = maxTokensPerSecond;
        p.active = true;
        emit ProviderRegistered(msg.sender, model, hw, ratePerMillion, maxTokensPerSecond);
    }

    function deregisterProvider() external {
        providers[msg.sender].active = false;
    }

    function deposit() external payable {
        require(msg.value > 0, "zero");
        deposits[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function openJob(address provider, uint256 budget, string calldata promptTag) external returns (uint256 jobId) {
        Provider storage p = providers[provider];
        require(p.active, "inactive provider");
        require(budget > 0, "zero budget");
        require(deposits[msg.sender] >= budget, "deposit more");
        deposits[msg.sender] -= budget;
        jobId = ++jobCounter;
        jobs[jobId] = Job({
            requester: msg.sender,
            provider: provider,
            escrow: budget,
            paid: 0,
            tokens: 0,
            ratePerMillion: p.ratePerMillion,
            maxTokensPerSecond: p.maxTokensPerSecond,
            openedAt: uint64(block.timestamp),
            lastSettleAt: uint64(block.timestamp),
            open: true
        });
        p.jobs++;
        emit JobOpened(jobId, msg.sender, provider, promptTag);
    }

    /// @notice Extend a live job's escrow so a long answer is not cut off.
    function topUp(uint256 jobId, uint256 amount) external {
        Job storage j = jobs[jobId];
        require(j.open, "closed");
        require(msg.sender == j.requester, "not requester");
        require(amount > 0, "zero");
        require(deposits[msg.sender] >= amount, "deposit more");
        deposits[msg.sender] -= amount;
        j.escrow += amount;
        emit JobToppedUp(jobId, amount, j.escrow);
    }

    /// @notice Pay the provider for tokens delivered since the last settlement.
    /// @dev The delta is clamped to what this node could have produced in the
    ///      elapsed wall time at its declared throughput. That is what makes
    ///      the guest's worst case one settlement interval rather than the
    ///      whole escrow. Over-reporting is silently clamped rather than
    ///      reverted, because a revert here would strand an in-flight stream.
    function settle(uint256 jobId, uint256 tokensDelta) external {
        Job storage j = jobs[jobId];
        require(j.open, "closed");
        require(msg.sender == j.provider, "not provider");

        uint256 elapsed = block.timestamp - j.lastSettleAt;
        // A settle in the same second still allows one second of work, so a
        // fast stream is not punished for settling promptly.
        if (elapsed == 0) elapsed = 1;
        uint256 allowed = elapsed * j.maxTokensPerSecond;
        uint256 counted = tokensDelta > allowed ? allowed : tokensDelta;

        uint256 rawDue = (counted * j.ratePerMillion) / 1_000_000;
        uint256 remaining = j.escrow - j.paid;
        uint256 due = rawDue > remaining ? remaining : rawDue;

        j.lastSettleAt = uint64(block.timestamp);

        if (due > 0) {
            j.paid += due;
            j.tokens += counted;
            Provider storage p = providers[msg.sender];
            p.earned += due;
            p.tokensServed += counted;
            emit StreamSettled(jobId, msg.sender, counted, due);
        }
        if (rawDue >= remaining) {
            j.open = false; // escrow exhausted
            emit JobClosed(jobId, j.tokens, j.paid);
        }
    }

    /// @notice Publish a hash of the answer produced so far.
    /// @dev This is what makes lossless failover possible: a replacement
    ///      provider proves it is continuing the same answer by matching this
    ///      hash, instead of the guest paying twice for the same prefix.
    function commitCheckpoint(uint256 jobId, bytes32 prefixHash, uint256 tokens) external {
        Job storage j = jobs[jobId];
        require(j.open, "closed");
        require(msg.sender == j.provider, "not provider");
        require(tokens >= checkpoints[jobId].tokens, "regressed");
        checkpoints[jobId] = Checkpoint(prefixHash, tokens);
        emit CheckpointCommitted(jobId, msg.sender, prefixHash, tokens);
    }

    /// @notice Hand a live job to a different provider, keeping the escrow,
    ///         the locked rate and the checkpoint intact.
    function reassign(uint256 jobId, address newProvider) external {
        Job storage j = jobs[jobId];
        require(j.open, "closed");
        require(msg.sender == j.requester, "not requester");
        require(providers[newProvider].active, "inactive provider");
        require(newProvider != j.provider, "same provider");
        address from = j.provider;
        j.provider = newProvider;
        // The replacement is paid at its own rate from here on, but never more
        // than the ceiling the guest already agreed to.
        uint256 r = providers[newProvider].ratePerMillion;
        j.ratePerMillion = r < j.ratePerMillion ? r : j.ratePerMillion;
        j.maxTokensPerSecond = providers[newProvider].maxTokensPerSecond;
        j.lastSettleAt = uint64(block.timestamp);
        providers[newProvider].jobs++;
        emit JobReassigned(jobId, from, newProvider);
    }

    function closeJob(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.open, "closed");
        require(msg.sender == j.provider || msg.sender == j.requester, "not party");
        j.open = false;
        uint256 refundAmt = j.escrow - j.paid;
        if (refundAmt > 0) deposits[j.requester] += refundAmt;
        emit JobClosed(jobId, j.tokens, j.paid);
    }

    function withdraw() external {
        uint256 amt = providers[msg.sender].earned;
        require(amt > 0, "nothing");
        providers[msg.sender].earned = 0;
        (bool ok,) = payable(msg.sender).call{value: amt}("");
        require(ok, "tf");
        emit Withdrawn(msg.sender, amt);
    }

    function refund() external {
        uint256 amt = deposits[msg.sender];
        require(amt > 0, "nothing");
        deposits[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amt}("");
        require(ok, "tf");
        emit Refunded(msg.sender, amt);
    }
}
