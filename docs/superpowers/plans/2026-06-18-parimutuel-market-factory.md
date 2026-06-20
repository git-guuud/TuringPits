# Parimutuel Faction-Win Market — Multi-Match Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `contracts/contracts/MafiaMarket.sol` from a single one-match-per-deploy escrow into a multi-match factory implementing the full parimutuel market layer (block-based lifecycle, fees, draw/void/refund, settlement timeout), reusing the existing verification libraries unchanged.

**Architecture:** One factory contract holds many matches keyed by `matchId`. A trusted `owner` creates matches; anyone bets within a block-based window; settlement reuses the proven per-move 0G-TEE-envelope + commit-reveal + Solidity Mafia-rules pipeline, then resolves to YES/NO/DRAW/VOID and caches a net pot for cheap pull-pattern claims. A settlement deadline enables a trustless full-refund path.

**Tech Stack:** Solidity 0.8.24, Hardhat + `@nomicfoundation/hardhat-toolbox`, ethers v6, Mocha/Chai, `@nomicfoundation/hardhat-network-helpers` for block mining.

**Spec:** `docs/superpowers/specs/2026-06-18-parimutuel-market-factory-design.md`

## Global Constraints

- Solidity pragma `^0.8.24`; rely on 0.8 checked arithmetic for overflow (no SafeMath, no explicit overflow guards needed for `+=`).
- **Do NOT modify** `contracts/contracts/lib/{DecisionCodec,TeeEnvelope,MafiaRules,StrUtils}.sol`. Reuse them verbatim.
- `MafiaTypes.sol` existing enums `Role/Phase/Action/Side` and `Decision` struct stay unchanged. Role enum order is `MAFIA=0, DOCTOR=1, DETECTIVE=2, TOWN=3` (matches `engine/src/commit.ts`); never reorder.
- Pull-pattern payouts only (no payout loops). Every external value transfer uses `(bool ok,) = addr.call{value:…}(""); require(ok, "transfer failed");`.
- Mark any mock explicitly with `// MOCK:`. The local test `teeSigner` is a labeled local key, not a real 0G TEE provider — this is already handled in the test helpers; do not introduce new silent mocks.
- Pools/stakes/netPot/winningPool are `uint128`; fee bps are `uint16`; block fields are `uint64`.
- Constants (exact values): `MIN_BET = 0.01 ether`, `MAX_BET_PER_TX = 10_000 ether`, `MIN_BETTING_WINDOW = 100`, `LOCK_BUFFER = 5`, `MIN_MATCH_DURATION = 25`, `MAX_FEE_BPS = 500`. Default fees in tests: `feeBps = 200`, `feeBpsDraw = 50`.
- Test command from `contracts/`: `npx hardhat test [path]`. The repo root is `/home/parth/Desktop/PARTH/TuringPits`; all `npx hardhat` commands run from `/home/parth/Desktop/PARTH/TuringPits/contracts`.
- Commit after each task. End every commit message body with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
  We are on `main` (default branch) — the executor must create a feature branch before the first commit.

---

### Task 1: Factory scaffold — constructor, storage, `createMatch`, `MatchCreated`

**Files:**
- Modify (full rewrite): `contracts/contracts/MafiaMarket.sol`
- Modify: `contracts/test/helpers/market.ts` (add `defaultSchedule`, `createParams`; return `teeSigner` from `buildSettlement`)
- Test (rewrite): `contracts/test/MafiaMarket.test.ts`

**Interfaces:**
- Produces:
  - `constructor(address _treasury)` — sets `owner = msg.sender`, `protocolTreasury = _treasury`.
  - `struct CreateMatchParams { bytes32 roleCommit; bytes32 personaPoolRoot; address teeSigner; string providerType; string providerIdentity; string tlsFingerprint; string nonce; uint8 playerCount; uint64 bettingOpenBlock; uint64 bettingCloseBlock; uint64 matchStartBlock; uint64 settlementDeadlineBlock; uint16 feeBps; uint16 feeBpsDraw; }`
  - `function createMatch(CreateMatchParams calldata p) external returns (uint256 matchId)` — `onlyOwner`.
  - `enum MatchState { None, Created, Locked, Settled, RefundMode }`, `enum Outcome { Unset, Yes, No, Draw, Void }`.
  - Public getters: `matches(uint256)`, `nextMatchId()`, `owner()`, `protocolTreasury()`.
  - `defaultSchedule(provider, overrides?)`, `createParams(opts)` test helpers; `buildSettlement` now also returns `teeSigner`.

- [ ] **Step 1: Add test helpers** to `contracts/test/helpers/market.ts`

Add the import line for `ethers` is already present. Append:

```ts
import { PROVIDER_META } from "./envelope";

/** Valid block schedule relative to the current chain head. */
export async function defaultSchedule(
  provider: { getBlockNumber(): Promise<number> },
  overrides: Partial<Record<"bettingOpenBlock" | "bettingCloseBlock" | "matchStartBlock" | "settlementDeadlineBlock", number>> = {},
) {
  const now = await provider.getBlockNumber();
  // Generous open margin: setup/validation tests fire several txs before betting; keep the
  // open block comfortably ahead of the head so "open in past" never masks other reverts.
  const bettingOpenBlock = now + 50;
  const bettingCloseBlock = bettingOpenBlock + 101; // > MIN_BETTING_WINDOW (100)
  const matchStartBlock = bettingCloseBlock + 5;    // >= LOCK_BUFFER
  const settlementDeadlineBlock = matchStartBlock + 26; // > MIN_MATCH_DURATION (25)
  return { bettingOpenBlock, bettingCloseBlock, matchStartBlock, settlementDeadlineBlock, ...overrides };
}

/** Assemble a CreateMatchParams object for ethers v6 (named struct fields). */
export function createParams(opts: {
  roleCommit: string;
  teeSigner: string;
  nonce: string;
  playerCount: number;
  schedule: { bettingOpenBlock: number; bettingCloseBlock: number; matchStartBlock: number; settlementDeadlineBlock: number };
  feeBps?: number;
  feeBpsDraw?: number;
  personaPoolRoot?: string;
}) {
  return {
    roleCommit: opts.roleCommit,
    personaPoolRoot: opts.personaPoolRoot ?? ethers.ZeroHash,
    teeSigner: opts.teeSigner,
    providerType: PROVIDER_META.providerType,
    providerIdentity: PROVIDER_META.providerIdentity,
    tlsFingerprint: PROVIDER_META.tlsFingerprint,
    nonce: opts.nonce,
    playerCount: opts.playerCount,
    bettingOpenBlock: opts.schedule.bettingOpenBlock,
    bettingCloseBlock: opts.schedule.bettingCloseBlock,
    matchStartBlock: opts.schedule.matchStartBlock,
    settlementDeadlineBlock: opts.schedule.settlementDeadlineBlock,
    feeBps: opts.feeBps ?? 200,
    feeBpsDraw: opts.feeBpsDraw ?? 50,
  };
}
```

Also add `teeSigner: signer` to the object returned by `buildSettlement`, and add `teeSigner: Wallet` to the `SettlementFixture` interface.

- [ ] **Step 2: Write the failing test** — replace the entire contents of `contracts/test/MafiaMarket.test.ts`:

```ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { defaultSchedule, createParams } from "./helpers/market";

const DUMMY_COMMIT = "0x" + "aa".repeat(32);

async function deploy() {
  const [owner, treasury, alice, bob] = await ethers.getSigners();
  const Market = await ethers.getContractFactory("MafiaMarket");
  const market = await Market.connect(owner).deploy(treasury.address);
  return { market, owner, treasury, alice, bob };
}

describe("MafiaMarket factory — createMatch", () => {
  it("constructor reverts on zero treasury", async () => {
    const [owner] = await ethers.getSigners();
    const Market = await ethers.getContractFactory("MafiaMarket");
    await expect(Market.connect(owner).deploy(ethers.ZeroAddress)).to.be.revertedWith("zero treasury");
  });

  it("creates a match, stores fields, emits MatchCreated, increments id", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    const p = createParams({ roleCommit: DUMMY_COMMIT, teeSigner: teeSigner.address, nonce: "m-1", playerCount: 5, schedule: sched });

    await expect(market.createMatch(p)).to.emit(market, "MatchCreated");
    expect(await market.nextMatchId()).to.equal(1);

    const m = await market.matches(0);
    expect(m.state).to.equal(1); // Created
    expect(m.roleCommit).to.equal(DUMMY_COMMIT);
    expect(m.teeSigner).to.equal(teeSigner.address);
    expect(m.bettingCloseBlock).to.equal(sched.bettingCloseBlock);
    expect(m.feeBps).to.equal(200);
    expect(m.entropySeed).to.not.equal(ethers.ZeroHash);
  });

  it("only owner can create", async () => {
    const { market, alice } = await deploy();
    const sched = await defaultSchedule(ethers.provider);
    const p = createParams({ roleCommit: DUMMY_COMMIT, teeSigner: alice.address, nonce: "m", playerCount: 5, schedule: sched });
    await expect(market.connect(alice).createMatch(p)).to.be.revertedWith("not owner");
  });

  it("validates schedule and fees", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const base = await defaultSchedule(ethers.provider);
    const mk = (over: any, extra: any = {}) =>
      createParams({ roleCommit: DUMMY_COMMIT, teeSigner: teeSigner.address, nonce: "m", playerCount: 5, schedule: { ...base, ...over }, ...extra });

    await expect(market.createMatch(mk({ bettingOpenBlock: 0 }))).to.be.revertedWith("open in past");
    await expect(market.createMatch(mk({ bettingCloseBlock: base.bettingOpenBlock + 50 }))).to.be.revertedWith("window too short");
    await expect(market.createMatch(mk({ matchStartBlock: base.bettingCloseBlock + 1 }))).to.be.revertedWith("no lock buffer");
    await expect(market.createMatch(mk({ settlementDeadlineBlock: base.matchStartBlock + 10 }))).to.be.revertedWith("deadline too soon");
    await expect(market.createMatch(mk({}, { feeBps: 600 }))).to.be.revertedWith("fee too high");
    await expect(market.createMatch(mk({}, { feeBps: 100, feeBpsDraw: 200 }))).to.be.revertedWith("draw fee > fee");
  });

  it("rejects zero signer and bad player count", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    await expect(market.createMatch(createParams({ roleCommit: DUMMY_COMMIT, teeSigner: ethers.ZeroAddress, nonce: "m", playerCount: 5, schedule: sched }))).to.be.revertedWith("zero signer");
    await expect(market.createMatch(createParams({ roleCommit: DUMMY_COMMIT, teeSigner: teeSigner.address, nonce: "m", playerCount: 4, schedule: sched }))).to.be.revertedWith("bad player count");
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `npx hardhat test test/MafiaMarket.test.ts`
Expected: compile error / FAIL — `MafiaMarket` constructor takes no args / `createMatch` undefined.

- [ ] **Step 4: Rewrite `contracts/contracts/MafiaMarket.sol`** with scaffold + `createMatch` only

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MafiaTypes.sol";
import "./lib/DecisionCodec.sol";
import "./lib/TeeEnvelope.sol";
import "./lib/MafiaRules.sol";

/// @title MafiaMarket — multi-match parimutuel YES/NO faction-win market factory with
///        fully on-chain, TEE-verified, trustless settlement for AI-Mafia matches.
contract MafiaMarket {
    enum MatchState { None, Created, Locked, Settled, RefundMode }
    enum Outcome { Unset, Yes, No, Draw, Void }

    struct Move {
        Decision decision;
        bytes rawResponseBody;
        uint256 contentOffset;
        uint256 contentLen;
        string reqHashHex;
        bytes signature;
    }

    struct CreateMatchParams {
        bytes32 roleCommit;
        bytes32 personaPoolRoot;
        address teeSigner;
        string providerType;
        string providerIdentity;
        string tlsFingerprint;
        string nonce;
        uint8 playerCount;
        uint64 bettingOpenBlock;
        uint64 bettingCloseBlock;
        uint64 matchStartBlock;
        uint64 settlementDeadlineBlock;
        uint16 feeBps;
        uint16 feeBpsDraw;
    }

    struct Match {
        MatchState state;
        uint64 bettingOpenBlock;
        uint64 bettingCloseBlock;
        uint64 matchStartBlock;
        uint64 settlementDeadlineBlock;
        bytes32 roleCommit;
        bytes32 entropySeed;
        bytes32 personaPoolRoot;
        address teeSigner;
        string providerType;
        string providerIdentity;
        string tlsFingerprint;
        string nonce;
        uint8 playerCount;
        uint128 poolYes;
        uint128 poolNo;
        Outcome outcome;
        uint128 netPot;
        uint128 winningPool;
        bytes32 transcriptCID;
        uint16 feeBps;
        uint16 feeBpsDraw;
    }

    uint256 public constant MIN_BET = 0.01 ether;
    uint256 public constant MAX_BET_PER_TX = 10_000 ether;
    uint64 public constant MIN_BETTING_WINDOW = 100;
    uint64 public constant LOCK_BUFFER = 5;
    uint64 public constant MIN_MATCH_DURATION = 25;
    uint16 public constant MAX_FEE_BPS = 500;

    address public owner;
    address public protocolTreasury;
    uint256 public nextMatchId;
    uint128 public protocolFeeAccrued;

    mapping(uint256 => Match) public matches;
    mapping(uint256 => mapping(address => uint128)) public stakeYes;
    mapping(uint256 => mapping(address => uint128)) public stakeNo;
    mapping(uint256 => mapping(address => bool)) public claimed;

    event MatchCreated(
        uint256 indexed matchId, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot,
        address teeSigner, uint8 playerCount,
        uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock
    );

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyTreasury() { require(msg.sender == protocolTreasury, "not treasury"); _; }

    constructor(address _treasury) {
        require(_treasury != address(0), "zero treasury");
        owner = msg.sender;
        protocolTreasury = _treasury;
    }

    function createMatch(CreateMatchParams calldata p) external onlyOwner returns (uint256 matchId) {
        require(p.bettingOpenBlock > block.number, "open in past");
        require(p.bettingCloseBlock > p.bettingOpenBlock + MIN_BETTING_WINDOW, "window too short");
        require(p.matchStartBlock >= p.bettingCloseBlock + LOCK_BUFFER, "no lock buffer");
        require(p.settlementDeadlineBlock > p.matchStartBlock + MIN_MATCH_DURATION, "deadline too soon");
        require(p.feeBps <= MAX_FEE_BPS, "fee too high");
        require(p.feeBpsDraw <= p.feeBps, "draw fee > fee");
        require(p.teeSigner != address(0), "zero signer");
        require(p.playerCount >= 5 && p.playerCount <= 7, "bad player count");

        matchId = nextMatchId++;
        Match storage m = matches[matchId];
        m.state = MatchState.Created;
        m.bettingOpenBlock = p.bettingOpenBlock;
        m.bettingCloseBlock = p.bettingCloseBlock;
        m.matchStartBlock = p.matchStartBlock;
        m.settlementDeadlineBlock = p.settlementDeadlineBlock;
        m.roleCommit = p.roleCommit;
        m.entropySeed = keccak256(abi.encodePacked(block.prevrandao, matchId, block.timestamp));
        m.personaPoolRoot = p.personaPoolRoot;
        m.teeSigner = p.teeSigner;
        m.providerType = p.providerType;
        m.providerIdentity = p.providerIdentity;
        m.tlsFingerprint = p.tlsFingerprint;
        m.nonce = p.nonce;
        m.playerCount = p.playerCount;
        m.feeBps = p.feeBps;
        m.feeBpsDraw = p.feeBpsDraw;

        emit MatchCreated(
            matchId, p.roleCommit, m.entropySeed, p.personaPoolRoot, p.teeSigner, p.playerCount,
            p.bettingOpenBlock, p.bettingCloseBlock, p.matchStartBlock, p.settlementDeadlineBlock
        );
    }
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npx hardhat test test/MafiaMarket.test.ts`
Expected: PASS (5 passing).

- [ ] **Step 6: Commit**

```bash
git add contracts/contracts/MafiaMarket.sol contracts/test/MafiaMarket.test.ts contracts/test/helpers/market.ts
git commit -m "feat(market): factory scaffold + createMatch with block-schedule validation"
```

---

### Task 2: Betting + lock — `betYes`/`betNo`, `lockBetting`, events

**Files:**
- Modify: `contracts/contracts/MafiaMarket.sol`
- Modify: `contracts/test/MafiaMarket.test.ts` (add `describe` block)

**Interfaces:**
- Consumes: `createMatch`, `matches`, `MatchState`, the test helpers from Task 1.
- Produces:
  - `function betYes(uint256 matchId) external payable;`
  - `function betNo(uint256 matchId) external payable;`
  - `function lockBetting(uint256 matchId) external;`
  - `event BetPlaced(uint256 indexed matchId, address indexed user, bool isYes, uint128 amount, uint128 newPoolYes, uint128 newPoolNo);`
  - `event BettingLocked(uint256 indexed matchId, uint128 finalPoolYes, uint128 finalPoolNo);`
  - getters `stakeYes(matchId,addr)`, `stakeNo(matchId,addr)`.

- [ ] **Step 1: Write the failing test** — append to `contracts/test/MafiaMarket.test.ts`:

```ts
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";

describe("MafiaMarket factory — betting + lock", () => {
  async function opened() {
    const { market, owner, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    const p = createParams({ roleCommit: DUMMY_COMMIT, teeSigner: teeSigner.address, nonce: "m-1", playerCount: 5, schedule: sched });
    await market.createMatch(p);
    return { market, owner, alice, bob, sched, matchId: 0 };
  }

  it("reverts a bet before the open block and after the close block", async () => {
    const { market, alice, sched, matchId } = await opened();
    await expect(market.connect(alice).betYes(matchId, { value: ethers.parseEther("1") })).to.be.revertedWith("betting not started");
    await mineUpTo(sched.bettingCloseBlock);
    await expect(market.connect(alice).betYes(matchId, { value: ethers.parseEther("1") })).to.be.revertedWith("betting closed");
  });

  it("reverts a bet on a nonexistent match", async () => {
    const { market, alice } = await opened();
    await expect(market.connect(alice).betYes(999, { value: ethers.parseEther("1") })).to.be.revertedWith("not open");
  });

  it("enforces MIN_BET and MAX_BET_PER_TX", async () => {
    const { market, alice, sched, matchId } = await opened();
    await mineUpTo(sched.bettingOpenBlock);
    await expect(market.connect(alice).betYes(matchId, { value: ethers.parseEther("0.001") })).to.be.revertedWith("below min bet");
    await expect(market.connect(alice).betYes(matchId, { value: ethers.parseEther("10001") })).to.be.revertedWith("above max bet");
  });

  it("accumulates pools + stakes and emits BetPlaced", async () => {
    const { market, alice, bob, sched, matchId } = await opened();
    await mineUpTo(sched.bettingOpenBlock);
    await expect(market.connect(alice).betYes(matchId, { value: ethers.parseEther("2") }))
      .to.emit(market, "BetPlaced");
    await market.connect(bob).betNo(matchId, { value: ethers.parseEther("3") });
    await market.connect(alice).betYes(matchId, { value: ethers.parseEther("1") });

    const m = await market.matches(matchId);
    expect(m.poolYes).to.equal(ethers.parseEther("3"));
    expect(m.poolNo).to.equal(ethers.parseEther("3"));
    expect(await market.stakeYes(matchId, alice.address)).to.equal(ethers.parseEther("3"));
    expect(await market.stakeNo(matchId, bob.address)).to.equal(ethers.parseEther("3"));
  });

  it("lockBetting reverts before close, transitions to Locked after", async () => {
    const { market, sched, matchId } = await opened();
    await expect(market.lockBetting(matchId)).to.be.revertedWith("betting still open");
    await mineUpTo(sched.bettingCloseBlock);
    await expect(market.lockBetting(matchId)).to.emit(market, "BettingLocked");
    expect((await market.matches(matchId)).state).to.equal(2); // Locked
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx hardhat test test/MafiaMarket.test.ts`
Expected: FAIL — `betYes`/`betNo`/`lockBetting` not a function.

- [ ] **Step 3: Add betting + lock to `MafiaMarket.sol`** (insert after `createMatch`, before the closing brace)

```solidity
    event BetPlaced(uint256 indexed matchId, address indexed user, bool isYes, uint128 amount, uint128 newPoolYes, uint128 newPoolNo);
    event BettingLocked(uint256 indexed matchId, uint128 finalPoolYes, uint128 finalPoolNo);

    function betYes(uint256 matchId) external payable { _bet(matchId, true); }
    function betNo(uint256 matchId) external payable { _bet(matchId, false); }

    function _bet(uint256 matchId, bool isYes) private {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Created, "not open");
        require(block.number >= m.bettingOpenBlock, "betting not started");
        require(block.number < m.bettingCloseBlock, "betting closed");
        require(msg.value >= MIN_BET, "below min bet");
        require(msg.value <= MAX_BET_PER_TX, "above max bet");
        uint128 amt = uint128(msg.value); // <= MAX_BET_PER_TX << 2^128
        if (isYes) {
            m.poolYes += amt;
            stakeYes[matchId][msg.sender] += amt;
        } else {
            m.poolNo += amt;
            stakeNo[matchId][msg.sender] += amt;
        }
        emit BetPlaced(matchId, msg.sender, isYes, amt, m.poolYes, m.poolNo);
    }

    function lockBetting(uint256 matchId) external {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Created, "not lockable");
        require(block.number >= m.bettingCloseBlock, "betting still open");
        m.state = MatchState.Locked;
        emit BettingLocked(matchId, m.poolYes, m.poolNo);
    }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx hardhat test test/MafiaMarket.test.ts`
Expected: PASS (createMatch + betting blocks all green).

- [ ] **Step 5: Commit**

```bash
git add contracts/contracts/MafiaMarket.sol contracts/test/MafiaMarket.test.ts
git commit -m "feat(market): block-gated betting, pool accounting, permissionless lock"
```

---

### Task 3: Settlement — `settle`, outcome resolution (Yes/No/Draw/Void), fees

**Files:**
- Modify: `contracts/contracts/MafiaMarket.sol`
- Modify: `contracts/test/MafiaMarket.test.ts` (add `describe` block; import `buildSettlement`, `buildEnvelope`)

**Interfaces:**
- Consumes: `MafiaRules.{init,applyDecision,Game}`, `TeeEnvelope.recover`, `DecisionCodec.{encode,jsonEscape}`, the `Move` struct, betting/lock from Task 2, `buildSettlement`/`buildEnvelope` test helpers.
- Produces:
  - `function settle(uint256 matchId, Move[] calldata moves, Role[] calldata revealedRoles, bytes32 salt, bytes32 transcriptCID) external;`
  - `event MatchSettled(uint256 indexed matchId, Outcome outcome, uint128 netPot, bytes32 transcriptCID);`
  - Match fields set: `outcome`, `winningPool`, `netPot`, `transcriptCID`, `state = Settled`; `protocolFeeAccrued += fee`.

- [ ] **Step 1: Write the failing test** — append to `contracts/test/MafiaMarket.test.ts` (add imports at top of file):

```ts
import { buildSettlement } from "./helpers/market";
import { buildEnvelope } from "./helpers/envelope";

const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

describe("MafiaMarket factory — settlement", () => {
  async function locked(nonce = "m-settle") {
    const { market, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, nonce, teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    // alice bets the engine-winning side, bob the losing side, so neither pool is empty.
    await market.connect(alice).betYes(0, { value: ethers.parseEther("1") });
    await market.connect(bob).betNo(0, { value: ethers.parseEther("3") });
    await mineUpTo(sched.bettingCloseBlock);
    return { market, alice, bob, fx, sched, matchId: 0, teeSigner };
  }

  it("settles to the on-chain-computed winner and caches net pot", async () => {
    const { market, fx, matchId } = await locked();
    await expect(market.settle(matchId, fx.moves, fx.roles, fx.salt, CID)).to.emit(market, "MatchSettled");
    const m = await market.matches(matchId);
    expect(m.state).to.equal(3); // Settled
    expect(m.outcome).to.equal(fx.mafiaWins ? 1 : 2); // Yes : No
    // gross = 4 ETH, fee = 2% = 0.08, netPot = 3.92
    expect(m.netPot).to.equal(ethers.parseEther("3.92"));
    expect(m.transcriptCID).to.equal(CID);
    expect(await market.protocolFeeAccrued()).to.equal(ethers.parseEther("0.08"));
  });

  it("reverts settle before close and after deadline", async () => {
    const { market, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-x", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-x", playerCount: 5, schedule: sched }));
    await expect(market.settle(0, fx.moves, fx.roles, fx.salt, CID)).to.be.revertedWith("betting still open");
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await expect(market.settle(0, fx.moves, fx.roles, fx.salt, CID)).to.be.revertedWith("deadline passed");
  });

  it("reverts a bad role reveal", async () => {
    const { market, fx, matchId } = await locked();
    const badRoles = [...fx.roles];
    badRoles[0] = badRoles[0] === 0 ? 3 : 0;
    await expect(market.settle(matchId, fx.moves, badRoles, fx.salt, CID)).to.be.revertedWith("role reveal mismatch");
  });

  it("reverts a forged signature (wrong key)", async () => {
    const { market, fx, matchId } = await locked();
    const attacker = ethers.Wallet.createRandom();
    const env = await buildEnvelope(attacker, '{"nonce":"x","phase":"night","round":1,"player":0,"action":"kill","target":2}');
    const tampered = fx.moves.map((mv: any) => ({ ...mv }));
    tampered[0] = { decision: fx.moves[0].decision, ...env };
    await expect(market.settle(matchId, tampered, fx.roles, fx.salt, CID)).to.be.reverted;
  });

  it("DRAW: a clean truncation resolves to Draw (no revert)", async () => {
    const { market, fx, matchId } = await locked();
    const truncated = fx.moves.slice(0, fx.moves.length - 1); // legal prefix, game unresolved
    await market.settle(matchId, truncated, fx.roles, fx.salt, CID);
    expect((await market.matches(matchId)).outcome).to.equal(3); // Draw
  });

  it("VOID: engine winner with an empty winning pool resolves to Void", async () => {
    const { market, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-void", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-void", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    // Bet ONLY the losing side, leaving the winning side's pool empty.
    if (fx.mafiaWins) await market.connect(alice).betNo(0, { value: ethers.parseEther("2") });
    else await market.connect(alice).betYes(0, { value: ethers.parseEther("2") });
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.matches(0)).outcome).to.equal(4); // Void
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx hardhat test test/MafiaMarket.test.ts`
Expected: FAIL — `settle` not a function.

- [ ] **Step 3: Add settlement to `MafiaMarket.sol`** (insert before the closing brace)

```solidity
    event MatchSettled(uint256 indexed matchId, Outcome outcome, uint128 netPot, bytes32 transcriptCID);

    function settle(
        uint256 matchId,
        Move[] calldata moves,
        Role[] calldata revealedRoles,
        bytes32 salt,
        bytes32 transcriptCID
    ) external {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Created || m.state == MatchState.Locked, "not settleable");
        require(block.number >= m.bettingCloseBlock, "betting still open");
        require(block.number <= m.settlementDeadlineBlock, "deadline passed");

        // 1. Commit-reveal: sha256(roleBytes ++ salt) == roleCommit (precompile 0x2).
        require(revealedRoles.length == m.playerCount, "roles length");
        bytes memory roleBytes = new bytes(revealedRoles.length);
        for (uint256 i = 0; i < revealedRoles.length; i++) {
            roleBytes[i] = bytes1(uint8(revealedRoles[i]));
        }
        require(sha256(bytes.concat(roleBytes, salt)) == m.roleCommit, "role reveal mismatch");

        // 2. Verify each move's TEE envelope + bind its decision, then run the rules engine.
        MafiaRules.Game memory g = _verifyAndApply(m, moves, revealedRoles);

        // 3. Resolve outcome: unresolved -> Draw; resolved but empty winning pool -> Void.
        Outcome outcome;
        uint128 winningPool;
        if (!g.over) {
            outcome = Outcome.Draw;
        } else if (g.mafiaWins) {
            winningPool = m.poolYes;
            outcome = winningPool == 0 ? Outcome.Void : Outcome.Yes;
        } else {
            winningPool = m.poolNo;
            outcome = winningPool == 0 ? Outcome.Void : Outcome.No;
        }

        // 4. Fees + net pot.
        uint128 gross = m.poolYes + m.poolNo;
        uint128 fee;
        if (outcome == Outcome.Yes || outcome == Outcome.No) {
            fee = uint128((uint256(gross) * m.feeBps) / 10000);
        } else if (outcome == Outcome.Draw) {
            fee = uint128((uint256(gross) * m.feeBpsDraw) / 10000);
        } // Void: fee stays 0

        m.outcome = outcome;
        m.winningPool = winningPool;
        m.netPot = gross - fee;
        m.transcriptCID = transcriptCID;
        protocolFeeAccrued += fee;
        m.state = MatchState.Settled;

        emit MatchSettled(matchId, outcome, m.netPot, transcriptCID);
    }

    function _verifyAndApply(
        Match storage m,
        Move[] calldata moves,
        Role[] calldata revealedRoles
    ) private view returns (MafiaRules.Game memory g) {
        g = MafiaRules.init(revealedRoles);
        for (uint256 i = 0; i < moves.length; i++) {
            Move calldata mv = moves[i];
            address signer = TeeEnvelope.recover(
                mv.rawResponseBody, mv.reqHashHex, m.providerType, m.providerIdentity, m.tlsFingerprint, mv.signature
            );
            require(signer == m.teeSigner, "bad TEE signature");

            string memory expected = DecisionCodec.jsonEscape(DecisionCodec.encode(m.nonce, mv.decision));
            require(_sliceEquals(mv.rawResponseBody, mv.contentOffset, mv.contentLen, bytes(expected)), "decision not bound to body");

            MafiaRules.applyDecision(g, mv.decision); // reverts on illegal/out-of-order
        }
    }

    function _sliceEquals(bytes calldata body, uint256 offset, uint256 len, bytes memory expected) private pure returns (bool) {
        if (offset + len > body.length) return false;
        if (len != expected.length) return false;
        return keccak256(body[offset:offset + len]) == keccak256(expected);
    }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx hardhat test test/MafiaMarket.test.ts`
Expected: PASS. If a "stack too deep" compile error occurs, confirm `_verifyAndApply`/`_sliceEquals` are separate functions (they are) — the optimizer (runs 200) handles the rest.

- [ ] **Step 5: Commit**

```bash
git add contracts/contracts/MafiaMarket.sol contracts/test/MafiaMarket.test.ts
git commit -m "feat(market): on-chain TEE-verified settle with Yes/No/Draw/Void resolution"
```

---

### Task 4: Claims — `claim`, per-outcome payouts, conservation, double-claim

**Files:**
- Modify: `contracts/contracts/MafiaMarket.sol`
- Modify: `contracts/test/MafiaMarket.test.ts` (add `describe` block)

**Interfaces:**
- Consumes: settlement from Task 3 (`outcome`, `netPot`, `winningPool`, `feeBpsDraw`), `claimed` mapping.
- Produces:
  - `function claim(uint256 matchId) external;`
  - `event Claimed(uint256 indexed matchId, address indexed user, uint256 payout);`

- [ ] **Step 1: Write the failing test** — append to `contracts/test/MafiaMarket.test.ts`:

```ts
describe("MafiaMarket factory — claims", () => {
  // Bet so that BOTH sides have multiple bettors; settle; check pro-rata + conservation.
  async function settled(nonce = "m-claim") {
    const { market, owner, treasury, alice, bob } = await deploy();
    const carol = (await ethers.getSigners())[4];
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, nonce, teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    const winSide = fx.mafiaWins ? "betYes" : "betNo";
    const loseSide = fx.mafiaWins ? "betNo" : "betYes";
    await market.connect(alice)[winSide](0, { value: ethers.parseEther("1") });
    await market.connect(carol)[winSide](0, { value: ethers.parseEther("3") });
    await market.connect(bob)[loseSide](0, { value: ethers.parseEther("2") });
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    return { market, alice, bob, carol, fx, matchId: 0 };
  }

  it("pays winners pro-rata net of fee and conserves the pot", async () => {
    const { market, alice, bob, carol, matchId } = await settled();
    // gross 6, fee 2% = 0.12, netPot 5.88, winningPool 4. alice 1/4 -> 1.47, carol 3/4 -> 4.41
    const a0 = await ethers.provider.getBalance(alice.address);
    const ta = await (await market.connect(alice).claim(matchId)).wait();
    const a1 = await ethers.provider.getBalance(alice.address);
    expect(a1 - a0 + ta!.gasUsed * ta!.gasPrice).to.equal(ethers.parseEther("1.47"));

    await market.connect(carol).claim(matchId);
    await expect(market.connect(bob).claim(matchId)).to.be.revertedWith("no winning stake");

    // Conservation: contract holds only fee + wei-dust after both winners claim.
    const bal = await ethers.provider.getBalance(await market.getAddress());
    const fee = ethers.parseEther("0.12");
    expect(bal - fee).to.be.lessThan(10n); // dust < a few wei
  });

  it("reverts double-claim", async () => {
    const { market, alice, matchId } = await settled();
    await market.connect(alice).claim(matchId);
    await expect(market.connect(alice).claim(matchId)).to.be.revertedWith("already claimed");
  });

  it("DRAW refunds own stake minus the draw fee", async () => {
    const { market, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-drawclaim", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-drawclaim", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice).betYes(0, { value: ethers.parseEther("1") });
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves.slice(0, fx.moves.length - 1), fx.roles, fx.salt, CID); // Draw
    const a0 = await ethers.provider.getBalance(alice.address);
    const tx = await (await market.connect(alice).claim(0)).wait();
    const a1 = await ethers.provider.getBalance(alice.address);
    // 1 ETH * (10000-50)/10000 = 0.995
    expect(a1 - a0 + tx!.gasUsed * tx!.gasPrice).to.equal(ethers.parseEther("0.995"));
  });

  it("VOID refunds full own stake", async () => {
    const { market, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-voidclaim", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-voidclaim", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    if (fx.mafiaWins) await market.connect(alice).betNo(0, { value: ethers.parseEther("2") });
    else await market.connect(alice).betYes(0, { value: ethers.parseEther("2") });
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID); // Void
    const a0 = await ethers.provider.getBalance(alice.address);
    const tx = await (await market.connect(alice).claim(0)).wait();
    const a1 = await ethers.provider.getBalance(alice.address);
    expect(a1 - a0 + tx!.gasUsed * tx!.gasPrice).to.equal(ethers.parseEther("2"));
  });

  it("reverts claim before settlement", async () => {
    const { market, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-early", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-early", playerCount: 5, schedule: sched }));
    await expect(market.connect(alice).claim(0)).to.be.revertedWith("not settled");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx hardhat test test/MafiaMarket.test.ts`
Expected: FAIL — `claim` not a function.

- [ ] **Step 3: Add `claim` to `MafiaMarket.sol`** (insert before the closing brace)

```solidity
    event Claimed(uint256 indexed matchId, address indexed user, uint256 payout);

    function claim(uint256 matchId) external {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Settled, "not settled");
        require(!claimed[matchId][msg.sender], "already claimed");

        uint256 payout;
        Outcome o = m.outcome;
        if (o == Outcome.Yes) {
            uint256 s = stakeYes[matchId][msg.sender];
            require(s > 0, "no winning stake");
            payout = (uint256(m.netPot) * s) / m.winningPool;
        } else if (o == Outcome.No) {
            uint256 s = stakeNo[matchId][msg.sender];
            require(s > 0, "no winning stake");
            payout = (uint256(m.netPot) * s) / m.winningPool;
        } else if (o == Outcome.Draw) {
            uint256 s = uint256(stakeYes[matchId][msg.sender]) + stakeNo[matchId][msg.sender];
            require(s > 0, "no stake");
            payout = (s * (10000 - m.feeBpsDraw)) / 10000;
        } else { // Void
            uint256 s = uint256(stakeYes[matchId][msg.sender]) + stakeNo[matchId][msg.sender];
            require(s > 0, "no stake");
            payout = s;
        }

        claimed[matchId][msg.sender] = true;
        (bool ok, ) = msg.sender.call{value: payout}("");
        require(ok, "transfer failed");
        emit Claimed(matchId, msg.sender, payout);
    }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx hardhat test test/MafiaMarket.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/contracts/MafiaMarket.sol contracts/test/MafiaMarket.test.ts
git commit -m "feat(market): pull-pattern claims for Yes/No/Draw/Void with conservation"
```

---

### Task 5: Refund mode — `enterRefundMode`, `refund`

**Files:**
- Modify: `contracts/contracts/MafiaMarket.sol`
- Modify: `contracts/test/MafiaMarket.test.ts` (add `describe` block)

**Interfaces:**
- Consumes: betting from Task 2, `claimed` mapping, `settlementDeadlineBlock`.
- Produces:
  - `function enterRefundMode(uint256 matchId) external;`
  - `function refund(uint256 matchId) external;`
  - `event RefundModeEntered(uint256 indexed matchId);`
  - `event Refunded(uint256 indexed matchId, address indexed user, uint256 payout);`

- [ ] **Step 1: Write the failing test** — append to `contracts/test/MafiaMarket.test.ts`:

```ts
describe("MafiaMarket factory — refund mode", () => {
  async function betThenIdle() {
    const { market, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-refund", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-refund", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice).betYes(0, { value: ethers.parseEther("1") });
    await market.connect(bob).betNo(0, { value: ethers.parseEther("2") });
    return { market, alice, bob, fx, sched, matchId: 0 };
  }

  it("enterRefundMode reverts before the deadline, works after", async () => {
    const { market, sched, matchId } = await betThenIdle();
    await mineUpTo(sched.bettingCloseBlock);
    await expect(market.enterRefundMode(matchId)).to.be.revertedWith("deadline not passed");
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await expect(market.enterRefundMode(matchId)).to.emit(market, "RefundModeEntered");
    expect((await market.matches(matchId)).state).to.equal(4); // RefundMode
  });

  it("refund returns each bettor's full stake; double-refund reverts", async () => {
    const { market, alice, sched, matchId } = await betThenIdle();
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(matchId);
    const a0 = await ethers.provider.getBalance(alice.address);
    const tx = await (await market.connect(alice).refund(matchId)).wait();
    const a1 = await ethers.provider.getBalance(alice.address);
    expect(a1 - a0 + tx!.gasUsed * tx!.gasPrice).to.equal(ethers.parseEther("1"));
    await expect(market.connect(alice).refund(matchId)).to.be.revertedWith("already refunded");
  });

  it("refund reverts before refund mode and for a non-bettor", async () => {
    const { market, alice, sched, matchId } = await betThenIdle();
    await expect(market.connect(alice).refund(matchId)).to.be.revertedWith("not refund mode");
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(matchId);
    const stranger = (await ethers.getSigners())[5];
    await expect(market.connect(stranger).refund(matchId)).to.be.revertedWith("no stake");
  });

  it("settle is blocked once in refund mode", async () => {
    const { market, fx, sched, matchId } = await betThenIdle();
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(matchId);
    await expect(market.settle(matchId, fx.moves, fx.roles, fx.salt, CID)).to.be.revertedWith("not settleable");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx hardhat test test/MafiaMarket.test.ts`
Expected: FAIL — `enterRefundMode`/`refund` not a function.

- [ ] **Step 3: Add refund mode to `MafiaMarket.sol`** (insert before the closing brace)

```solidity
    event RefundModeEntered(uint256 indexed matchId);
    event Refunded(uint256 indexed matchId, address indexed user, uint256 payout);

    function enterRefundMode(uint256 matchId) external {
        Match storage m = matches[matchId];
        require(m.state == MatchState.Created || m.state == MatchState.Locked, "not refundable");
        require(block.number > m.settlementDeadlineBlock, "deadline not passed");
        m.state = MatchState.RefundMode;
        emit RefundModeEntered(matchId);
    }

    function refund(uint256 matchId) external {
        Match storage m = matches[matchId];
        require(m.state == MatchState.RefundMode, "not refund mode");
        require(!claimed[matchId][msg.sender], "already refunded");
        uint256 s = uint256(stakeYes[matchId][msg.sender]) + stakeNo[matchId][msg.sender];
        require(s > 0, "no stake");
        claimed[matchId][msg.sender] = true;
        (bool ok, ) = msg.sender.call{value: s}("");
        require(ok, "transfer failed");
        emit Refunded(matchId, msg.sender, s);
    }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx hardhat test test/MafiaMarket.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/contracts/MafiaMarket.sol contracts/test/MafiaMarket.test.ts
git commit -m "feat(market): settlement-timeout refund mode with full stake reclaim"
```

---

### Task 6: Protocol fees + conservation fuzz

**Files:**
- Modify: `contracts/contracts/MafiaMarket.sol`
- Modify: `contracts/test/MafiaMarket.test.ts` (add `describe` block for fees)
- Create: `contracts/test/MafiaMarket.fuzz.test.ts`

**Interfaces:**
- Consumes: `protocolFeeAccrued`, `protocolTreasury`, `onlyTreasury`, claims from Task 4.
- Produces:
  - `function withdrawProtocolFees() external;` — `onlyTreasury`.

- [ ] **Step 1: Write the failing fee test** — append to `contracts/test/MafiaMarket.test.ts`:

```ts
describe("MafiaMarket factory — protocol fees", () => {
  it("only treasury can withdraw; sweep transfers accrued fees", async () => {
    const { market, treasury, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-fee", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-fee", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice)[fx.mafiaWins ? "betYes" : "betNo"](0, { value: ethers.parseEther("1") });
    await market.connect(bob)[fx.mafiaWins ? "betNo" : "betYes"](0, { value: ethers.parseEther("3") });
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);

    await expect(market.connect(alice).withdrawProtocolFees()).to.be.revertedWith("not treasury");
    const t0 = await ethers.provider.getBalance(treasury.address);
    const tx = await (await market.connect(treasury).withdrawProtocolFees()).wait();
    const t1 = await ethers.provider.getBalance(treasury.address);
    expect(t1 - t0 + tx!.gasUsed * tx!.gasPrice).to.equal(ethers.parseEther("0.08")); // 2% of 4
    expect(await market.protocolFeeAccrued()).to.equal(0);
  });

  it("reverts withdraw when nothing accrued", async () => {
    const { market, treasury } = await deploy();
    await expect(market.connect(treasury).withdrawProtocolFees()).to.be.revertedWith("nothing to withdraw");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx hardhat test test/MafiaMarket.test.ts`
Expected: FAIL — `withdrawProtocolFees` not a function.

- [ ] **Step 3: Add `withdrawProtocolFees` to `MafiaMarket.sol`** (insert before the closing brace)

```solidity
    function withdrawProtocolFees() external onlyTreasury {
        uint128 amt = protocolFeeAccrued;
        require(amt > 0, "nothing to withdraw");
        protocolFeeAccrued = 0;
        (bool ok, ) = protocolTreasury.call{value: amt}("");
        require(ok, "transfer failed");
    }
```

- [ ] **Step 4: Run the fee test, verify it passes**

Run: `npx hardhat test test/MafiaMarket.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the conservation fuzz test** — create `contracts/test/MafiaMarket.fuzz.test.ts`:

```ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, buildSettlement } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

// Deterministic PRNG so failures reproduce.
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("MafiaMarket — conservation property (fuzz)", () => {
  it("for random bet sequences, Σ claims + fee == gross within dust and no payout exceeds gross", async () => {
    const rand = mulberry32(42);
    for (let iter = 0; iter < 8; iter++) {
      const signers = await ethers.getSigners();
      const [owner, treasury] = signers;
      const bettors = signers.slice(2, 8);
      const Market = await ethers.getContractFactory("MafiaMarket");
      const market = await Market.connect(owner).deploy(treasury.address);
      const teeSigner = ethers.Wallet.createRandom();
      const nonce = `fuzz-${iter}`;
      const fx = await buildSettlement(SEED, 5, nonce, teeSigner);
      const sched = await defaultSchedule(ethers.provider);
      await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: 5, schedule: sched }));
      await mineUpTo(sched.bettingOpenBlock);

      // Random bets; force at least one bet on the winning side so the outcome is Yes/No (not Void).
      const winFn = fx.mafiaWins ? "betYes" : "betNo";
      const loseFn = fx.mafiaWins ? "betNo" : "betYes";
      await market.connect(bettors[0])[winFn](0, { value: ethers.parseEther("1") });
      for (let i = 1; i < bettors.length; i++) {
        const amt = ethers.parseEther((0.05 + rand() * 5).toFixed(4));
        await market.connect(bettors[i])[rand() < 0.5 ? winFn : loseFn](0, { value: amt });
      }
      await mineUpTo(sched.bettingCloseBlock);
      await market.settle(0, fx.moves, fx.roles, fx.salt, CID);

      const m = await market.matches(0);
      const gross = m.poolYes + m.poolNo;
      let claimsTotal = 0n;
      for (const b of bettors) {
        const stake = (await market.stakeYes(0, b.address)) + (await market.stakeNo(0, b.address));
        const won = fx.mafiaWins ? await market.stakeYes(0, b.address) : await market.stakeNo(0, b.address);
        if (won === 0n) continue;
        const before = await ethers.provider.getBalance(await market.getAddress());
        await market.connect(b).claim(0);
        const after = await ethers.provider.getBalance(await market.getAddress());
        const payout = before - after;
        expect(payout).to.be.lessThanOrEqual(gross); // no payout exceeds the whole pot
        claimsTotal += payout;
        expect(stake).to.be.greaterThan(0n);
      }
      const fee = await market.protocolFeeAccrued();
      const dust = gross - (claimsTotal + fee);
      expect(dust).to.be.greaterThanOrEqual(0n);
      expect(dust).to.be.lessThan(BigInt(bettors.length)); // wei-scale floor-division dust only
    }
  });
});
```

- [ ] **Step 6: Run the fuzz test, verify it passes**

Run: `npx hardhat test test/MafiaMarket.fuzz.test.ts`
Expected: PASS (1 passing, may take a few seconds).

- [ ] **Step 7: Commit**

```bash
git add contracts/contracts/MafiaMarket.sol contracts/test/MafiaMarket.test.ts contracts/test/MafiaMarket.fuzz.test.ts
git commit -m "feat(market): protocol fee withdrawal + conservation fuzz property"
```

---

### Task 7: Deploy script, cross-layer integration update, docs

**Files:**
- Modify: `contracts/scripts/deploy.ts`
- Modify: `contracts/test/PlayersIntegration.test.ts`
- Modify: `STATUS.md`

**Interfaces:**
- Consumes: the full factory API.
- Produces: a deploy script that passes a treasury; an updated cross-layer test using the factory ABI.

- [ ] **Step 1: Inspect the current integration test** so the rewrite preserves its intent

Run: `cat contracts/test/PlayersIntegration.test.ts`
Note which `playMatch`/fixture helpers it calls; it currently uses the OLD ABI (`openMarket`, `placeBet`, `settle(moves,roles,salt)`).

- [ ] **Step 2: Update `contracts/scripts/deploy.ts`** to pass a treasury

Replace the deploy line block:

```ts
  const treasury = process.env.PROTOCOL_TREASURY ?? deployer.address;
  const MafiaMarket = await ethers.getContractFactory("MafiaMarket");
  const market = await MafiaMarket.deploy(treasury);
  await market.waitForDeployment();
```

Leave the logging lines; add `console.log("Treasury:", treasury);` after the address log.

- [ ] **Step 3: Update `contracts/test/PlayersIntegration.test.ts`** to the factory ABI

Convert its lifecycle to: deploy with a treasury, `createMatch(createParams({...}))` using the fixture's `commit`/`teeSigner`/`nonce`/`playerCount` and `defaultSchedule`, `mineUpTo(open)`, place a winning-side bet, `mineUpTo(close)`, `settle(0, moves, roles, salt, CID)`, assert `matches(0).outcome` equals the engine winner (`fx.mafiaWins ? 1 : 2`), and a winning `claim(0)` succeeds. Reuse `buildSettlement`, `defaultSchedule`, `createParams`, `mineUpTo` exactly as in `MafiaMarket.test.ts`. Keep the test's existing intent (a real `playMatch`/scripted transcript settles to the engine-declared winner through the deployed lifecycle).

- [ ] **Step 4: Run the full contracts suite**

Run: `npx hardhat test`
Expected: ALL green — `MafiaMarket.test.ts`, `MafiaMarket.fuzz.test.ts`, `PlayersIntegration.test.ts`, plus the unchanged `DecisionCodec`/`MafiaRules`/`TeeEnvelope` library tests.

- [ ] **Step 5: Update `STATUS.md`**

Edit the Day-5 "Known limitations" bullet to record that the rewrite **closes both gaps**: (1) the zero-bet-winner trapped pool is handled by the `Void` outcome (full refund), and (2) the missing settlement timeout is handled by `enterRefundMode`/`refund` past `settlementDeadlineBlock`. Add a one-line note that `MafiaMarket` is now a multi-match factory (matchId-keyed) with fees, block-based lifecycle, and event emissions, per `docs/superpowers/specs/2026-06-18-parimutuel-market-factory-design.md`. Note the deployed address `0xd4d1007585f9bAa44DaBbBCb224a09395F41ca5F` is now **stale** (old ABI) — re-deploy needed for Day 6.

- [ ] **Step 6: Commit**

```bash
git add contracts/scripts/deploy.ts contracts/test/PlayersIntegration.test.ts STATUS.md
git commit -m "chore(market): factory deploy script, cross-layer test + STATUS update"
```

---

## Self-Review

**1. Spec coverage:**
- §2 decisions — factory/single-host (Task 1 `onlyOwner`), block-based lifecycle (Tasks 1–3,5), no seed/bond (no payment in `createMatch`), preserved libraries (Global Constraints + Task 3 reuse), no VRF (settle omits it). ✅
- §3 storage — `Match`/`MatchState`/`Outcome`/mappings/constants (Task 1). ✅
- §4 functions — createMatch (T1), bet/lock (T2), settle (T3), claim (T4), enterRefundMode/refund (T5), withdrawProtocolFees (T6). ✅
- §5 verification — commit-reveal + envelope + binding + rules + changed terminal branch (T3). ✅
- §6 payouts — Yes/No/Draw/Void + RefundMode, conservation (T4, T6). ✅
- §7 trims — entropySeed generated-not-enforced (T1), personaPoolRoot stored-not-enforced (T1), no settler bounty / dust sweep / VRF (by omission). ✅
- §8 events — all seven emitted across T1–T5. ✅
- §10 tests — lifecycle, accounting, conservation, draw, void, refund, double-claim, fuzz, cross-layer (T1–T7). ✅
- §11 exit criteria — full suite green (T7 Step 4). ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". Task 3 Step 3 step note about stack-too-deep is a real compile contingency, not a placeholder. Task 7 Step 3 describes the PlayersIntegration rewrite in prose because the exact current contents are read in Step 1; the conversion target (the new lifecycle calls) is fully specified and identical to patterns shown verbatim in earlier tasks. ✅

**3. Type consistency:** `CreateMatchParams` fields match `createParams` helper keys; `Outcome` integer mapping used consistently in tests (Yes=1, No=2, Draw=3, Void=4); `MatchState` (Created=1, Locked=2, Settled=3, RefundMode=4); `_verifyAndApply`/`_sliceEquals` defined in T3 and referenced only there; `protocolFeeAccrued`/`protocolTreasury` consistent T1→T6. ✅
