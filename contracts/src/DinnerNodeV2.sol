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

    /// @notice A plan the guest approved before any of its steps ran.
    /// @dev What this DOES enforce: once committed, settle() can never take a
    ///      job's `paid` above `ceiling`, whatever the escrow is. That turns
    ///      the cost ceiling the guest approved from a promise made by a web
    ///      page into a limit held by the chain, and raising it costs the
    ///      guest a transaction they have to sign.
    ///
    ///      What it CANNOT do, stated here so nobody builds a claim on it: the
    ///      contract cannot check that the steps a provider ran are the steps
    ///      in the plan. `planHash` is a commitment for later audit, not a
    ///      proof of execution. Anyone comparing an answer to a plan is doing
    ///      it off chain, against this hash. Claiming otherwise would be the
    ///      DinnerZK mistake again: a shaped ritual with no property.
    struct PlanCommitment {
        bytes32 planHash;
        /// Monotonic. A revision is a new commitment rather than an edit, so
        /// the history of what was approved cannot be rewritten.
        uint256 version;
        /// Wei. The most this job may ever pay while this plan stands.
        uint256 ceiling;
        uint64 committedAt;
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
    event PlanCommitted(uint256 indexed jobId, bytes32 indexed planHash, uint256 version, uint256 ceiling);
    event JobReassigned(uint256 indexed jobId, address indexed from, address indexed to);
    event JobClosed(uint256 indexed jobId, uint256 totalTokens, uint256 totalPaid);
    event Withdrawn(address indexed provider, uint256 amount);
    event Refunded(address indexed requester, uint256 amount);

    mapping(address => Provider) public providers;
    mapping(address => uint256) public deposits;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => Checkpoint) public checkpoints;
    mapping(uint256 => PlanCommitment) public plans;
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
        uint256 escrowRemaining = j.escrow - j.paid;
        // A committed plan lowers the ceiling from the escrow to the figure
        // the guest actually approved. This is the whole enforceable content
        // of commitPlan: the guest cannot be charged past the number they
        // signed for, even though the escrow would allow it.
        uint256 remaining = escrowRemaining;
        PlanCommitment storage pc = plans[jobId];
        if (pc.planHash != bytes32(0)) {
            uint256 planRemaining = pc.ceiling > j.paid ? pc.ceiling - j.paid : 0;
            if (planRemaining < remaining) remaining = planRemaining;
        }
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
        // Closed on the ESCROW being spent, never on the plan ceiling being
        // reached. Closing at the ceiling would make an upward revision
        // impossible: the guest would have to open a new job, losing the
        // checkpoint chain and paying openJob again, exactly when they have
        // just decided the work is worth more. Reaching the ceiling stops
        // payment and leaves the job open for commitPlan to raise it.
        //
        // Tested against `paid` rather than against `rawDue`, which is what
        // the provider CLAIMED rather than what the escrow actually gave up.
        // Comparing rawDue closed a job whose escrow was untouched the moment
        // a plan capped a large claim, which is the case this whole feature
        // exists to create. Identical to the old behaviour when no plan is
        // committed, because there `due` is capped only by the escrow.
        if (j.paid >= j.escrow) {
            j.open = false; // escrow exhausted
            emit JobClosed(jobId, j.tokens, j.paid);
        }
    }

    /// @notice Commit the plan this job is executing, and the most it may cost.
    /// @dev Sent by the REQUESTER, not the provider. The guest is the party
    ///      who approves a plan, and a provider able to commit one could raise
    ///      its own ceiling.
    ///
    ///      Committing again with a higher version is how a revision works.
    ///      That is deliberate: a revision that costs more than the guest
    ///      already approved requires a transaction the guest signs, which is
    ///      the lazy-approval boundary in src/plan.ts made real rather than
    ///      enforced by a web page that could simply not ask.
    /// @param planHash keccak256 of the canonical plan. See canonicalize() in
    ///        src/plan.ts; the two must agree byte for byte or the commitment
    ///        is worthless.
    /// @param version Plan version. Must exceed the version already committed.
    /// @param ceiling Wei this job may pay in total while this plan stands.
    function commitPlan(uint256 jobId, bytes32 planHash, uint256 version, uint256 ceiling) external {
        Job storage j = jobs[jobId];
        require(j.open, "closed");
        require(msg.sender == j.requester, "not your job");
        require(planHash != bytes32(0), "empty plan");
        require(version > 0, "zero version");
        require(ceiling > 0, "zero ceiling");
        // A ceiling above the escrow would be a promise the escrow cannot
        // keep, and settle() would stop at the escrow anyway.
        require(ceiling <= j.escrow, "ceiling over escrow");

        PlanCommitment storage c = plans[jobId];
        require(version > c.version, "stale version");
        // A revision cannot retroactively cap work the provider has already
        // been paid for. Without this a guest could settle a run and then
        // commit a lower ceiling, which changes nothing on chain but makes the
        // record say the provider was overpaid against an approved plan.
        require(ceiling >= j.paid, "ceiling below work already paid");

        plans[jobId] = PlanCommitment({
            planHash: planHash,
            version: version,
            ceiling: ceiling,
            committedAt: uint64(block.timestamp)
        });
        emit PlanCommitted(jobId, planHash, version, ceiling);
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
