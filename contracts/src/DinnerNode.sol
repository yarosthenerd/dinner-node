
pragma solidity ^0.8.28;

contract DinnerNode {
    struct Provider {
        string model;
        string hw;
        uint256 ratePerMillion;
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
        bool open;
    }

    event ProviderRegistered(address indexed provider, string model, string hw, uint256 ratePerMillion);
    event Deposited(address indexed requester, uint256 amount);
    event JobOpened(uint256 indexed jobId, address indexed requester, address indexed provider, string promptTag);
    event StreamSettled(uint256 indexed jobId, address indexed provider, uint256 tokensDelta, uint256 amount);
    event JobClosed(uint256 indexed jobId, uint256 totalTokens, uint256 totalPaid);
    event Withdrawn(address indexed provider, uint256 amount);
    event Refunded(address indexed requester, uint256 amount);

    mapping(address => Provider) public providers;
    mapping(address => uint256) public deposits;
    mapping(uint256 => Job) public jobs;
    uint256 public jobCounter;

    function registerProvider(string calldata model, string calldata hw, uint256 ratePerMillion) external {
        Provider storage p = providers[msg.sender];
        p.model = model; p.hw = hw; p.ratePerMillion = ratePerMillion; p.active = true;
        emit ProviderRegistered(msg.sender, model, hw, ratePerMillion);
    }

    function deposit() external payable {
        require(msg.value > 0, "zero");
        deposits[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function openJob(address provider, uint256 budget, string calldata promptTag)
        external returns (uint256 jobId)
    {
        require(providers[provider].active, "inactive provider");
        require(deposits[msg.sender] >= budget, "deposit more");
        deposits[msg.sender] -= budget;
        jobId = ++jobCounter;
        jobs[jobId] = Job(msg.sender, provider, budget, 0, 0, true);
        providers[provider].jobs++;
        emit JobOpened(jobId, msg.sender, provider, promptTag);
    }

    function settle(uint256 jobId, uint256 tokensDelta) external {
        Job storage j = jobs[jobId];
        require(j.open, "closed");
        require(msg.sender == j.provider, "not provider");

        uint256 rawDue = (tokensDelta * providers[msg.sender].ratePerMillion) / 1_000_000;
        uint256 remaining = j.escrow - j.paid;
        uint256 due = rawDue > remaining ? remaining : rawDue;

        if (due > 0) {
            j.paid += due;
            j.tokens += tokensDelta;
            Provider storage p = providers[msg.sender];
            p.earned += due;
            p.tokensServed += tokensDelta;
            emit StreamSettled(jobId, msg.sender, tokensDelta, due);
        }
        if (rawDue >= remaining) {
            j.open = false; // escrow exhausted
            emit JobClosed(jobId, j.tokens, j.paid);
        }
    }

    function closeJob(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.open, "closed");
        require(msg.sender == j.provider || msg.sender == j.requester, "not party");
        j.open = false;
        uint256 refund = j.escrow - j.paid;
        if (refund > 0) deposits[j.requester] += refund;
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
