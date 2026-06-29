import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, deployMarket, fundBettors } from "./helpers/market";
import { buildSettlement } from "./helpers/market";
import { buildEnvelope } from "./helpers/envelope";

const DUMMY_COMMIT = "0x" + "aa".repeat(32);
const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

async function deploy() {
  const [owner, treasury, alice, bob, carol, stranger] = await ethers.getSigners();
  const { market, token } = await deployMarket(owner, treasury);
  // Mint + approve CHIP for every signer the tests bet from.
  await fundBettors(token, await market.getAddress(), [alice, bob, carol, stranger]);
  return { market, token, owner, treasury, alice, bob, carol, stranger };
}

describe("MafiaMarket factory — createMatch", () => {
  it("constructor reverts on zero treasury / zero token", async () => {
    const [owner] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockBetToken");
    const token = await Token.connect(owner).deploy(ethers.ZeroAddress); // no forwarder needed for this check
    const Market = await ethers.getContractFactory("MafiaMarket");
    const fwd = ethers.ZeroAddress;
    await expect(Market.connect(owner).deploy(ethers.ZeroAddress, await token.getAddress(), fwd)).to.be.revertedWith("zero treasury");
    await expect(Market.connect(owner).deploy(owner.address, ethers.ZeroAddress, fwd)).to.be.revertedWith("zero token");
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

describe("MafiaMarket factory — betting + lock", () => {
  async function opened() {
    const { market, token, owner, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    const p = createParams({ roleCommit: DUMMY_COMMIT, teeSigner: teeSigner.address, nonce: "m-1", playerCount: 5, schedule: sched });
    await market.createMatch(p);
    return { market, token, owner, alice, bob, sched, matchId: 0 };
  }

  it("reverts a bet before open, stays open past the close block, reverts past the deadline", async () => {
    const { market, alice, sched, matchId } = await opened();
    await expect(market.connect(alice).betYes(matchId, ethers.parseEther("1"))).to.be.revertedWith("betting not started");
    await mineUpTo(sched.bettingOpenBlock);
    // Market stays OPEN until settled — a bet well past the old close block still succeeds.
    await mineUpTo(sched.bettingCloseBlock + 10);
    await market.connect(alice).betYes(matchId, ethers.parseEther("1"));
    expect((await market.matches(matchId)).poolYes).to.equal(ethers.parseEther("1"));
    // Past the settlement deadline the match is refund-eligible, so new stakes are refused.
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await expect(market.connect(alice).betYes(matchId, ethers.parseEther("1"))).to.be.revertedWith("betting closed");
  });

  it("reverts a bet on a nonexistent match", async () => {
    const { market, alice } = await opened();
    await expect(market.connect(alice).betYes(999, ethers.parseEther("1"))).to.be.revertedWith("not open");
  });

  it("enforces MIN_BET and MAX_BET_PER_TX", async () => {
    const { market, alice, sched, matchId } = await opened();
    await mineUpTo(sched.bettingOpenBlock);
    await expect(market.connect(alice).betYes(matchId, ethers.parseEther("0.001"))).to.be.revertedWith("below min bet");
    await expect(market.connect(alice).betYes(matchId, ethers.parseEther("10001"))).to.be.revertedWith("above max bet");
  });

  it("reverts a bet without sufficient allowance", async () => {
    const { market, token, alice, sched, matchId } = await opened();
    await mineUpTo(sched.bettingOpenBlock);
    await token.connect(alice).approve(await market.getAddress(), 0); // revoke approval
    await expect(market.connect(alice).betYes(matchId, ethers.parseEther("1"))).to.be.revertedWith("insufficient allowance");
  });

  it("accumulates pools + stakes and emits BetPlaced; pulls CHIP into escrow", async () => {
    const { market, token, alice, bob, sched, matchId } = await opened();
    await mineUpTo(sched.bettingOpenBlock);
    const aBefore = await token.balanceOf(alice.address);
    await expect(market.connect(alice).betYes(matchId, ethers.parseEther("2")))
      .to.emit(market, "BetPlaced");
    await market.connect(bob).betNo(matchId, ethers.parseEther("3"));
    await market.connect(alice).betYes(matchId, ethers.parseEther("1"));

    const m = await market.matches(matchId);
    expect(m.poolYes).to.equal(ethers.parseEther("3"));
    expect(m.poolNo).to.equal(ethers.parseEther("3"));
    expect(await market.stakeYes(matchId, alice.address)).to.equal(ethers.parseEther("3"));
    expect(await market.stakeNo(matchId, bob.address)).to.equal(ethers.parseEther("3"));
    // Alice's CHIP went into the contract.
    expect(aBefore - (await token.balanceOf(alice.address))).to.equal(ethers.parseEther("3"));
    expect(await token.balanceOf(await market.getAddress())).to.equal(ethers.parseEther("6"));
  });

  it("lockBetting reverts before close, transitions to Locked after", async () => {
    const { market, sched, matchId } = await opened();
    await expect(market.lockBetting(matchId)).to.be.revertedWith("betting still open");
    await mineUpTo(sched.bettingCloseBlock);
    await expect(market.lockBetting(matchId)).to.emit(market, "BettingLocked");
    expect((await market.matches(matchId)).state).to.equal(2); // Locked
  });
});

describe("MafiaMarket factory — settlement", () => {
  async function locked(nonce = "m-settle") {
    const { market, token, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, nonce, teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    // alice bets the engine-winning side, bob the losing side, so neither pool is empty.
    await market.connect(alice).betYes(0, ethers.parseEther("1"));
    await market.connect(bob).betNo(0, ethers.parseEther("3"));
    await mineUpTo(sched.bettingCloseBlock);
    return { market, token, alice, bob, fx, sched, matchId: 0, teeSigner };
  }

  it("settles to the on-chain-computed winner and caches net pot", async () => {
    const { market, fx, matchId } = await locked();
    await expect(market.settle(matchId, fx.moves, fx.roles, fx.salt, CID)).to.emit(market, "MatchSettled");
    const m = await market.matches(matchId);
    expect(m.state).to.equal(3); // Settled
    expect(m.outcome).to.equal(fx.mafiaWins ? 1 : 2); // Yes : No
    // gross = 4 CHIP, fee = 2% = 0.08, netPot = 3.92
    expect(m.netPot).to.equal(ethers.parseEther("3.92"));
    expect(m.transcriptCID).to.equal(CID);
    expect(await market.protocolFeeAccrued()).to.equal(ethers.parseEther("0.08"));
  });

  it("can settle before the old close block (no minimum betting window)", async () => {
    const { market, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-early-settle", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-early-settle", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice).betYes(0, ethers.parseEther("1"));
    // Settle immediately — well before bettingCloseBlock — proving betting closes on settle, not on a block.
    await expect(market.settle(0, fx.moves, fx.roles, fx.salt, CID)).to.emit(market, "MatchSettled");
    expect((await market.matches(0)).state).to.equal(3); // Settled
  });

  it("reverts settle after the deadline", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-x", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-x", playerCount: 5, schedule: sched }));
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
    // scriptedMatch breaks exactly when a faction wins, so the final move is the winning one; any strict legal prefix leaves the game unresolved -> Draw.
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
    if (fx.mafiaWins) await market.connect(alice).betNo(0, ethers.parseEther("2"));
    else await market.connect(alice).betYes(0, ethers.parseEther("2"));
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.matches(0)).outcome).to.equal(4); // Void
  });
});

describe("MafiaMarket factory — claims", () => {
  // Bet so that BOTH sides have multiple bettors; settle; check pro-rata + conservation.
  async function settled(nonce = "m-claim") {
    const { market, token, owner, treasury, alice, bob, carol } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, nonce, teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    const winSide = fx.mafiaWins ? "betYes" : "betNo";
    const loseSide = fx.mafiaWins ? "betNo" : "betYes";
    await market.connect(alice)[winSide](0, ethers.parseEther("1"));
    await market.connect(carol)[winSide](0, ethers.parseEther("3"));
    await market.connect(bob)[loseSide](0, ethers.parseEther("2"));
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    return { market, token, alice, bob, carol, fx, matchId: 0 };
  }

  it("pays winners pro-rata net of fee and conserves the pot", async () => {
    const { market, token, alice, bob, carol, matchId } = await settled();
    // gross 6, fee 2% = 0.12, netPot 5.88, winningPool 4. alice 1/4 -> 1.47, carol 3/4 -> 4.41
    const a0 = await token.balanceOf(alice.address);
    await market.connect(alice).claim(matchId);
    const a1 = await token.balanceOf(alice.address);
    expect(a1 - a0).to.equal(ethers.parseEther("1.47"));

    await market.connect(carol).claim(matchId);
    await expect(market.connect(bob).claim(matchId)).to.be.revertedWith("no winning stake");

    // Conservation: contract holds only fee + wei-dust after both winners claim.
    const bal = await token.balanceOf(await market.getAddress());
    const fee = ethers.parseEther("0.12");
    expect(bal - fee).to.be.lessThan(10n); // dust < a few wei
  });

  it("reverts double-claim", async () => {
    const { market, alice, matchId } = await settled();
    await market.connect(alice).claim(matchId);
    await expect(market.connect(alice).claim(matchId)).to.be.revertedWith("already claimed");
  });

  it("DRAW refunds own stake minus the draw fee", async () => {
    const { market, token, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-drawclaim", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-drawclaim", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice).betYes(0, ethers.parseEther("1"));
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves.slice(0, fx.moves.length - 1), fx.roles, fx.salt, CID); // Draw
    const a0 = await token.balanceOf(alice.address);
    await market.connect(alice).claim(0);
    const a1 = await token.balanceOf(alice.address);
    // 1 CHIP * (10000-50)/10000 = 0.995
    expect(a1 - a0).to.equal(ethers.parseEther("0.995"));
  });

  it("VOID refunds full own stake", async () => {
    const { market, token, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-voidclaim", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-voidclaim", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    if (fx.mafiaWins) await market.connect(alice).betNo(0, ethers.parseEther("2"));
    else await market.connect(alice).betYes(0, ethers.parseEther("2"));
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID); // Void
    const a0 = await token.balanceOf(alice.address);
    await market.connect(alice).claim(0);
    const a1 = await token.balanceOf(alice.address);
    expect(a1 - a0).to.equal(ethers.parseEther("2"));
  });

  it("reverts claim before settlement", async () => {
    const { market, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-early", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-early", playerCount: 5, schedule: sched }));
    await expect(market.connect(alice).claim(0)).to.be.revertedWith("not settled");
  });

  it("isolates stakes across matchIds (no cross-match claim)", async () => {
    const { market, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx0 = await buildSettlement(SEED, 5, "iso-0", teeSigner);
    const s0 = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx0.commit, teeSigner: teeSigner.address, nonce: "iso-0", playerCount: 5, schedule: s0 }));
    const fx1 = await buildSettlement(SEED, 5, "iso-1", teeSigner);
    const s1 = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx1.commit, teeSigner: teeSigner.address, nonce: "iso-1", playerCount: 5, schedule: s1 }));
    await mineUpTo(Math.max(s0.bettingOpenBlock, s1.bettingOpenBlock));
    await market.connect(alice)[fx0.mafiaWins ? "betYes" : "betNo"](0, ethers.parseEther("1"));
    await market.connect(bob)[fx1.mafiaWins ? "betYes" : "betNo"](1, ethers.parseEther("1"));
    await mineUpTo(Math.max(s0.bettingCloseBlock, s1.bettingCloseBlock));
    await market.settle(0, fx0.moves, fx0.roles, fx0.salt, CID);
    await market.settle(1, fx1.moves, fx1.roles, fx1.salt, CID);
    // Alice has no stake in match 1 -> cannot claim it, even though she won match 0.
    expect(await market.stakeYes(1, alice.address)).to.equal(0);
    expect(await market.stakeNo(1, alice.address)).to.equal(0);
    await expect(market.connect(alice).claim(1)).to.be.revertedWith("no winning stake");
    await market.connect(alice).claim(0); // her match-0 claim still works
  });
});

describe("MafiaMarket factory — refund mode", () => {
  async function betThenIdle() {
    const { market, token, alice, bob, stranger } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-refund", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-refund", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice).betYes(0, ethers.parseEther("1"));
    await market.connect(bob).betNo(0, ethers.parseEther("2"));
    return { market, token, alice, bob, stranger, fx, sched, matchId: 0 };
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
    const { market, token, alice, sched, matchId } = await betThenIdle();
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(matchId);
    const a0 = await token.balanceOf(alice.address);
    await market.connect(alice).refund(matchId);
    const a1 = await token.balanceOf(alice.address);
    expect(a1 - a0).to.equal(ethers.parseEther("1"));
    await expect(market.connect(alice).refund(matchId)).to.be.revertedWith("already refunded");
  });

  it("refund reverts before refund mode and for a non-bettor", async () => {
    const { market, alice, stranger, sched, matchId } = await betThenIdle();
    await expect(market.connect(alice).refund(matchId)).to.be.revertedWith("not refund mode");
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(matchId);
    await expect(market.connect(stranger).refund(matchId)).to.be.revertedWith("no stake");
  });

  it("settle is blocked once in refund mode", async () => {
    const { market, fx, sched, matchId } = await betThenIdle();
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(matchId);
    await expect(market.settle(matchId, fx.moves, fx.roles, fx.salt, CID)).to.be.revertedWith("not settleable");
  });
});

describe("MafiaMarket factory — protocol fees", () => {
  it("only treasury can withdraw; sweep transfers accrued fees", async () => {
    const { market, token, treasury, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-fee", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-fee", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice)[fx.mafiaWins ? "betYes" : "betNo"](0, ethers.parseEther("1"));
    await market.connect(bob)[fx.mafiaWins ? "betNo" : "betYes"](0, ethers.parseEther("3"));
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);

    await expect(market.connect(alice).withdrawProtocolFees()).to.be.revertedWith("not treasury");
    const t0 = await token.balanceOf(treasury.address);
    await market.connect(treasury).withdrawProtocolFees();
    const t1 = await token.balanceOf(treasury.address);
    expect(t1 - t0).to.equal(ethers.parseEther("0.08")); // 2% of 4
    expect(await market.protocolFeeAccrued()).to.equal(0);
  });

  it("reverts withdraw when nothing accrued", async () => {
    const { market, treasury } = await deploy();
    await expect(market.connect(treasury).withdrawProtocolFees()).to.be.revertedWith("nothing to withdraw");
  });
});
