// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Registry and streaming escrow for DinnerNode.
/// @dev v2 exists to close a defect in v1: settle() accepted any tokensDelta
///      from the provider, capped only by the remaining escrow, so a single
///      call could take the whole escrow for zero work. The README promised
///      "guest worst-case loss = one settlement" and the code did not deliver
///      it. v2 makes that promise true by bounding each settlement to the
///      tokens the provider could plausibly have produced since the previous
///      one, and by locking the rate at the moment the job opens.
///
///      Four bounds now stack, and it is worth being precise about which one
///      does what, because each covers a case the others do not:
///
///        1. Throughput.  A settlement can never exceed elapsed wall time at
///           the throughput the node declared and the job locked. Always on.
///        2. Published progress.  A settlement can never take a job's paid
///           token count past what the provider has published a checkpoint
///           for. This is what stops a REPLACEMENT provider being paid for the
///           prefix it inherited: `tokens` is cumulative across providers, so
///           a newcomer's headroom is what it published minus what the job has
///           already paid for, not the whole answer. Applies whenever a
///           checkpoint exists, and `requireCheckpoints` makes it mandatory.
///        3. Plan ceiling.  A committed plan caps total payment at the figure
///           the guest signed for, whatever the escrow allows.
///        4. Escrow.  Nothing is ever paid that was not deposited.
contract DinnerNodeV2 {
    struct Provider {
        string model;
        string hw;
        uint256 ratePerMillion;
        uint256 maxTokensPerSecond; // throughput ceiling this node claims
        /// Withdrawable balance, not a reputation figure: withdraw() zeroes it.
        uint256 earned;
        /// Reputation. Both of these only ever count arm's-length work; see
        /// the note on _isArmsLength.
        uint256 lifetimeEarned;
        uint256 tokensServed;
        uint256 jobs;
        bool active;
    }

    struct Job {
        address requester;
        address provider;
        uint256 escrow;
        uint256 paid;
        /// Cumulative BILLABLE tokens this job has paid for, across every
        /// provider that has held it. Never reset by reassign, which is what
        /// makes bound 2 above work.
        uint256 tokens;
        uint256 ratePerMillion;     // locked at open, immune to later re-registration
        uint256 maxTokensPerSecond; // locked at open, for the same reason
        uint64 openedAt;
        uint64 lastSettleAt;
        bool open;
        /// Set by the requester at open. When true, settle() refuses to pay for
        /// tokens the provider has not published a checkpoint for, which turns
        /// bound 2 from something a provider opts into by publishing to
        /// something it cannot avoid. A streaming answer should set it; a plan
        /// run cannot, because a plan has no single growing prefix to hash.
        bool requireCheckpoints;
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

    /// @notice The provider's published record of how far the answer has got.
    /// @dev Two counts, because they cover different things and conflating them
    ///      was going to break either billing or the failover claim.
    ///
    ///      `tokens` is VISIBLE tokens, and is what `prefixHash` hashes. It is
    ///      the number a replacement provider needs: it is handed that much
    ///      text and must reproduce the same hash before it continues.
    ///
    ///      `billed` is visible PLUS reasoning, and is the number settle()
    ///      clamps against. Reasoning is streamed to the guest and charged for
    ///      (terms 3.1) but is deliberately not part of the hash chain, because
    ///      the chain has to cover exactly the text a replacement is given.
    ///      Clamping payment against `tokens` would have made reasoning
    ///      unbillable; clamping against `billed` keeps both properties.
    struct Checkpoint {
        bytes32 prefixHash;
        uint256 tokens;
        uint256 billed;
        /// Rolling hash over every checkpoint this job has ever had, including
        /// which provider published it. A same-height rewrite is already
        /// refused by the strict-advance rule in _checkpoint, and this makes
        /// the whole sequence auditable rather than just its latest entry:
        /// a verifier who kept the frames can recompute this and see that no
        /// intermediate checkpoint was swapped.
        bytes32 chainHash;
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
    event CheckpointCommitted(uint256 indexed jobId, address indexed provider, bytes32 prefixHash, uint256 tokens, uint256 billed, bytes32 chainHash);
    event PlanCommitted(uint256 indexed jobId, bytes32 indexed planHash, uint256 version, uint256 ceiling);
    event JobReassigned(uint256 indexed jobId, address indexed from, address indexed to, uint256 settledOut);
    /// @notice The escrow is spent. The job stays OPEN; see the note in settle.
    event JobExhausted(uint256 indexed jobId, uint256 totalTokens, uint256 totalPaid);
    event JobClosed(uint256 indexed jobId, uint256 totalTokens, uint256 totalPaid);
    event Withdrawn(address indexed provider, uint256 amount);
    event Refunded(address indexed requester, uint256 amount);

    mapping(address => Provider) public providers;
    mapping(address => uint256) public deposits;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => Checkpoint) public checkpoints;
    mapping(uint256 => PlanCommitment) public plans;
    uint256 public jobCounter;

    /// @notice How many times each job has been handed over under a signed
    ///         authorisation. Only ever increases, which is what makes one
    ///         signature usable for a bounded number of handovers and no more.
    mapping(uint256 => uint256) public reassignCount;

    // ---- EIP-712 -----------------------------------------------------------
    //
    // Why this exists at all: reassign() requires msg.sender == j.requester, so
    // every failover was a transaction the guest had to approve by hand. That
    // makes an unattended session impossible. A node dying at 3am leaves the
    // answer stopped until a human wakes up and confirms a wallet prompt,
    // which is the opposite of what a streaming escrow with a standby node is
    // for.
    //
    // The fix keeps the guest as the authority and moves their approval
    // earlier: they sign a typed message once, when they order, and the
    // INCOMING provider submits it at the moment of the handover. No key is
    // delegated, nothing is custodial, and the guest's own wallet is still the
    // only thing that can authorise a handover of their job.
    bytes32 public constant REASSIGN_AUTH_TYPEHASH = keccak256(
        "ReassignAuth(uint256 jobId,address newProvider,uint256 maxReassigns,uint64 deadline)"
    );
    /// Cached, and rebuilt if the chain id ever differs from the one at
    /// construction, so a signature can never be replayed across a fork.
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable _CACHED_CHAIN_ID;

    constructor() {
        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("DinnerNode"),
            keccak256("2"),
            block.chainid,
            address(this)
        ));
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _CACHED_CHAIN_ID ? _CACHED_DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    /// @notice The digest a guest signs to authorise unattended handovers of
    ///         one job. Published so a client builds it from the contract
    ///         rather than reimplementing the encoding and drifting.
    /// @param newProvider The only address allowed to take the job, or the
    ///        zero address to allow any registered active provider.
    function reassignAuthDigest(
        uint256 jobId,
        address newProvider,
        uint256 maxReassigns,
        uint64 deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            REASSIGN_AUTH_TYPEHASH, jobId, newProvider, maxReassigns, deadline
        ));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    // ---- reads -------------------------------------------------------------
    //
    // The public mappings above return a positional tuple, and viem decodes it
    // positionally whether or not the ABI names the outputs. That has already
    // cost this project once: v2 moves `open` from index 5 to index 9, and a
    // non-zero rate sitting at the old index reads as truthy, so every
    // liveness check in a client written against v1 would silently pass on a
    // closed job. A single struct return decodes to a NAMED object, which
    // makes that class of drift impossible rather than merely unlikely.
    // Clients should read through these two and never index a tuple.

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    function getProvider(address provider) external view returns (Provider memory) {
        return providers[provider];
    }

    function getCheckpoint(uint256 jobId) external view returns (Checkpoint memory) {
        return checkpoints[jobId];
    }

    function getPlan(uint256 jobId) external view returns (PlanCommitment memory) {
        return plans[jobId];
    }

    /// @notice What this job could still pay out right now, under every bound
    ///         except throughput. Published so a client can show the guest a
    ///         real number instead of recomputing the rules and drifting.
    function remainingBudget(uint256 jobId) public view returns (uint256) {
        Job storage j = jobs[jobId];
        uint256 remaining = j.escrow - j.paid;
        PlanCommitment storage pc = plans[jobId];
        if (pc.planHash != bytes32(0)) {
            uint256 planRemaining = pc.ceiling > j.paid ? pc.ceiling - j.paid : 0;
            if (planRemaining < remaining) remaining = planRemaining;
        }
        return remaining;
    }

    // ---- registry ----------------------------------------------------------

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

    /// @notice Is this job at arm's length, or is a provider paying itself?
    /// @dev Reputation counters are the one thing here a provider can inflate
    ///      for the price of gas: register, deposit, open a job against
    ///      yourself, settle in a loop, and the MON goes round in a circle
    ///      while `tokensServed` climbs. Discovery sorts on `tokensServed`, so
    ///      that is a ranking attack, not a bookkeeping wart.
    ///
    ///      Excluding self-dealing closes the direct version and nothing more.
    ///      A provider willing to run two wallets still inflates its numbers at
    ///      the cost of gas, and no on-chain rule fixes that. Stated plainly
    ///      because the honest claim is "harder and no longer free", not
    ///      "prevented". Ranking on figures a stranger attested to is the real
    ///      answer and it lives in DinnerRatings, not here.
    function _isArmsLength(Job storage j) internal view returns (bool) {
        return j.requester != j.provider;
    }

    function openJob(address provider, uint256 budget, string calldata promptTag, bool requireCheckpoints)
        external
        returns (uint256 jobId)
    {
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
            open: true,
            requireCheckpoints: requireCheckpoints
        });
        if (msg.sender != provider) p.jobs++;
        emit JobOpened(jobId, msg.sender, provider, promptTag);
    }

    /// @notice Extend a live job's escrow so a long answer is not cut off.
    /// @dev This is why settle() no longer closes a job when the escrow runs
    ///      out. It used to, in the same transaction that spent the last of it,
    ///      so a guest who wanted to continue could never win the race: by the
    ///      time they saw the balance fall the job was closed and topUp
    ///      reverted with "closed". The only recovery was a new job, which
    ///      loses the checkpoint chain and pays openJob twice.
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

    // ---- checkpoints -------------------------------------------------------

    /// @dev Strictly advancing, in both counts. The old guard used `>=` on a
    ///      single count, which let a provider rewrite the hash at the same
    ///      height as often as it liked: publish a checkpoint, then publish a
    ///      different prefix hash for the same token count, and the record of
    ///      what was actually produced becomes whatever was written last. A
    ///      checkpoint is meant to be evidence, and evidence that can be
    ///      overwritten in place is not evidence.
    ///
    ///      `billed` must advance at least as much as `tokens`, because every
    ///      visible token is also a billed one. Reasoning is what makes the
    ///      inequality strict in practice.
    function _checkpoint(uint256 jobId, bytes32 prefixHash, uint256 tokens, uint256 billed) internal {
        Checkpoint storage cp = checkpoints[jobId];
        require(tokens > cp.tokens, "checkpoint must advance");
        require(billed >= tokens, "billed below visible");
        require(billed > cp.billed, "billed must advance");
        bytes32 chainHash = keccak256(abi.encode(cp.chainHash, prefixHash, tokens, billed, msg.sender));
        checkpoints[jobId] = Checkpoint(prefixHash, tokens, billed, chainHash);
        emit CheckpointCommitted(jobId, msg.sender, prefixHash, tokens, billed, chainHash);
    }

    /// @notice Publish a hash of the answer produced so far.
    /// @dev This is what makes lossless failover possible: a replacement
    ///      provider proves it is continuing the same answer by matching this
    ///      hash, instead of the guest paying twice for the same prefix.
    ///      Available on its own, though a streaming node should prefer the
    ///      checkpoint arguments on settle(), which do the same thing without
    ///      a second transaction.
    function commitCheckpoint(uint256 jobId, bytes32 prefixHash, uint256 tokens, uint256 billed) external {
        Job storage j = jobs[jobId];
        require(j.open, "closed");
        require(msg.sender == j.provider, "not provider");
        require(prefixHash != bytes32(0), "empty checkpoint");
        _checkpoint(jobId, prefixHash, tokens, billed);
    }

    // ---- settlement --------------------------------------------------------

    /// @notice Pay the provider for tokens delivered since the last settlement,
    ///         optionally publishing the checkpoint that evidences them.
    /// @dev Over-reporting is silently clamped rather than reverted, because a
    ///      revert here would strand an in-flight stream. The one thing that
    ///      does revert is a job that demanded checkpoints not getting one:
    ///      that is a misconfigured provider, not a racing stream, and paying
    ///      it anyway would quietly void the guarantee the guest asked for.
    /// @param prefixHash Pass bytes32(0) to settle without publishing a
    ///        checkpoint. A plan run does this: it has no single growing
    ///        prefix, and its ceiling comes from commitPlan instead.
    function settle(uint256 jobId, uint256 tokensDelta, bytes32 prefixHash, uint256 prefixTokens, uint256 billedTotal) public {
        Job storage j = jobs[jobId];
        require(j.open, "closed");
        require(msg.sender == j.provider, "not provider");

        if (prefixHash != bytes32(0)) {
            _checkpoint(jobId, prefixHash, prefixTokens, billedTotal);
        } else {
            require(!j.requireCheckpoints, "checkpoint required");
        }

        uint256 counted = _allowed(j, checkpoints[jobId], tokensDelta);
        uint256 rawDue = (counted * j.ratePerMillion) / 1_000_000;
        uint256 remaining = remainingBudget(jobId);
        uint256 due = rawDue > remaining ? remaining : rawDue;

        j.lastSettleAt = uint64(block.timestamp);

        if (due > 0) {
            j.paid += due;
            j.tokens += counted;
            _credit(j, msg.sender, due, counted);
            emit StreamSettled(jobId, msg.sender, counted, due);
        }

        // Announced, not acted on. The job stays open so topUp can rescue it;
        // see the note on topUp for what auto-closing here used to cost. A job
        // whose escrow is spent pays nothing on every later settle, because
        // remainingBudget is zero, so leaving it open is inert rather than
        // risky. Closing it is the provider's call, and host.ts already does
        // that at end of stream and on the session idle timer.
        if (j.paid >= j.escrow) emit JobExhausted(jobId, j.tokens, j.paid);
    }

    /// @notice Settle without publishing a checkpoint.
    /// @dev Convenience for plan runs. Reverts on a job that requires them.
    function settle(uint256 jobId, uint256 tokensDelta) external {
        settle(jobId, tokensDelta, bytes32(0), 0, 0);
    }

    /// @dev Bounds 1 and 2 from the contract header, in one place so settle and
    ///      reassign cannot drift apart on what a provider is owed.
    function _allowed(Job storage j, Checkpoint storage cp, uint256 tokensDelta) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - j.lastSettleAt;
        // A settle in the same second still allows one second of work, so a
        // fast stream is not punished for settling promptly.
        if (elapsed == 0) elapsed = 1;
        uint256 allowed = elapsed * j.maxTokensPerSecond;
        uint256 counted = tokensDelta > allowed ? allowed : tokensDelta;

        // Published progress. `j.tokens` is cumulative across every provider
        // this job has had, so a replacement that publishes a checkpoint
        // covering the whole answer still only has the unpaid tail as headroom.
        // That is the double-payment this bound exists to stop.
        if (cp.billed > 0) {
            uint256 proven = cp.billed > j.tokens ? cp.billed - j.tokens : 0;
            if (counted > proven) counted = proven;
        }
        return counted;
    }

    /// @dev `earned` is a balance and always accrues, or a provider could be
    ///      robbed of real money by a guest opening a job against them. The
    ///      reputation counters beside it are the ones self-dealing inflates.
    function _credit(Job storage j, address provider, uint256 due, uint256 counted) internal {
        Provider storage p = providers[provider];
        p.earned += due;
        if (_isArmsLength(j)) {
            p.lifetimeEarned += due;
            p.tokensServed += counted;
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

    // ---- failover ----------------------------------------------------------

    /// @notice Hand a live job to a different provider, keeping the escrow,
    ///         the locked rate and the checkpoint intact.
    /// @dev The outgoing provider is PAID OUT first, up to what its published
    ///      checkpoint evidences. Without that, reassign was the mirror of the
    ///      defect this whole contract exists to fix: a requester could let a
    ///      node stream for a full settlement interval and then reassign a
    ///      moment before it settled, taking the work for nothing, repeatably
    ///      and for the price of one transaction. A provider whose exposure is
    ///      one settlement interval against a guest who can time that interval
    ///      is a provider with no protection at all.
    ///
    ///      It is bounded by exactly the same rules a settle would have been,
    ///      because it calls the same _allowed: nothing here lets an outgoing
    ///      provider take more than it could have taken by settling normally,
    ///      and a provider that published no checkpoint gets nothing, which is
    ///      the incentive to publish them.
    function reassign(uint256 jobId, address newProvider) external {
        require(msg.sender == jobs[jobId].requester, "not requester");
        _reassign(jobId, newProvider);
    }

    /// @notice Hand a job over on the strength of a signature the requester
    ///         gave earlier, submitted by the provider taking the job.
    /// @dev This is what makes an unattended session possible. reassign()
    ///      needs the guest at the keyboard, so a node dying mid-answer at 3am
    ///      stops the answer until a human confirms a wallet prompt. Here the
    ///      guest signs once at order time and the replacement carries the
    ///      authorisation to the chain itself.
    ///
    ///      The guest's authority is not weakened, only moved earlier. Four
    ///      things bound what the signature can be used for:
    ///
    ///        - `deadline`, so an authorisation does not outlive the session it
    ///          was given for.
    ///        - `maxReassigns`, checked against a counter that only increases,
    ///          so one signature buys a bounded number of handovers rather
    ///          than an open licence. It is also the replay protection: there
    ///          is no separate nonce to keep in step.
    ///        - `newProvider`, which either names the single address allowed to
    ///          take the job, or is the zero address for "any registered active
    ///          provider". The client signs the wildcard, because at order time
    ///          it does not yet know which standby will still be alive.
    ///        - `msg.sender == newProvider`, so only the node actually taking
    ///          the work can submit it. A third party cannot bounce someone
    ///          else's job around, and nobody can hand a job to a machine that
    ///          is not itself party to the transaction.
    ///
    ///      What the guest risks by signing the wildcard is liveness, not
    ///      money: every payment bound in this contract still applies to the
    ///      replacement. The rate can only move down (see _reassign), the
    ///      throughput ceiling can only move down, a provider that publishes no
    ///      checkpoint is still paid nothing, and nothing is ever paid that was
    ///      not deposited. The worst a hostile registered provider achieves is
    ///      to take a job and serve it badly, which the guest ends with
    ///      closeJob and their remaining escrow returns to them.
    function reassignWithAuth(
        uint256 jobId,
        address newProvider,
        uint256 maxReassigns,
        uint64 deadline,
        bytes calldata signature
    ) external {
        Job storage j = jobs[jobId];
        require(j.open, "closed");
        // Checked before the signature, because these are the cheap reasons a
        // handover is refused and they cost the caller less gas to discover.
        require(msg.sender == newProvider, "not the new provider");
        require(block.timestamp <= deadline, "auth expired");
        require(reassignCount[jobId] < maxReassigns, "auth spent");

        // The signature either names nobody or names this provider, and a
        // wildcard authorisation must be verified as the wildcard it was
        // signed as rather than as this address, or the digest will not match.
        // The wildcard is tried first because it is what the client signs: at
        // order time it does not know which standby will still be alive, so
        // the named form is the rarer case and pays the extra recover.
        bytes32 digest = reassignAuthDigest(jobId, address(0), maxReassigns, deadline);
        address signer = ECDSA.recover(digest, signature);
        if (signer != j.requester) {
            digest = reassignAuthDigest(jobId, newProvider, maxReassigns, deadline);
            signer = ECDSA.recover(digest, signature);
            require(signer == j.requester, "bad auth");
        }

        reassignCount[jobId]++;
        _reassign(jobId, newProvider);
    }

    function _reassign(uint256 jobId, address newProvider) internal {
        Job storage j = jobs[jobId];
        require(j.open, "closed");
        require(providers[newProvider].active, "inactive provider");
        require(newProvider != j.provider, "same provider");

        address from = j.provider;

        // Settle out the outgoing provider against its own published progress.
        //
        // Guarded on a checkpoint EXISTING, not merely applied when one does.
        // _allowed skips the published-progress bound on a job that has never
        // checkpointed, which is right for settle -- a plan run has no prefix
        // and its ceiling comes from commitPlan -- and wrong here: asking for
        // the maximum would have paid a departing provider a full throughput
        // allowance on no evidence at all, including on a job reassigned in
        // the same second it opened. Nothing published, nothing owed, which is
        // also the incentive to publish.
        Checkpoint storage cp = checkpoints[jobId];
        uint256 counted = cp.billed > 0 ? _allowed(j, cp, type(uint256).max) : 0;
        uint256 settledOut = 0;
        if (counted > 0) {
            uint256 rawDue = (counted * j.ratePerMillion) / 1_000_000;
            uint256 remaining = remainingBudget(jobId);
            settledOut = rawDue > remaining ? remaining : rawDue;
            if (settledOut > 0) {
                j.paid += settledOut;
                j.tokens += counted;
                _credit(j, from, settledOut, counted);
                emit StreamSettled(jobId, from, counted, settledOut);
            }
        }

        j.provider = newProvider;
        // The replacement is paid at its own rate from here on, but never more
        // than the ceiling the guest already agreed to.
        uint256 r = providers[newProvider].ratePerMillion;
        j.ratePerMillion = r < j.ratePerMillion ? r : j.ratePerMillion;
        // Throughput moves the same way, and for the same reason. Taking the
        // replacement's figure outright let a reassign RAISE the ceiling that
        // bound 1 enforces: swap to a node declaring 10,000 tok/s and every
        // later settlement is allowed ten thousand tokens per elapsed second,
        // on a job the guest opened against a node that claimed a hundred. The
        // lock at openJob has to survive a handover or it is not a lock.
        uint256 tps = providers[newProvider].maxTokensPerSecond;
        j.maxTokensPerSecond = tps < j.maxTokensPerSecond ? tps : j.maxTokensPerSecond;
        j.lastSettleAt = uint64(block.timestamp);
        if (j.requester != newProvider) providers[newProvider].jobs++;
        emit JobReassigned(jobId, from, newProvider, settledOut);
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
