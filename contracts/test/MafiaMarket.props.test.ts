import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, deployMarket, fundBettors, buildSettlement } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

// PropKind enum (MafiaMarket.sol): PlayerFate=0, RoundVotedOut=1, NightKill=2.
const KIND = { PlayerFate: 0, RoundVotedOut: 1, NightKill: 2 } as const;
// PropState enum (MafiaMarket.sol): Unset=0, Resolved=1, Void=2.
const PS = { Unset: 0, Resolved: 1, Void: 2 } as const;

async function deploy() {
  const [owner, treasury, alice, bob, carol, stranger] = await ethers.getSigners();
  const { market, token } = await deployMarket(owner, treasury);
  await fundBettors(token, await market.getAddress(), [alice, bob, carol, stranger]);
  return { market, token, owner, treasury, alice, bob, carol, stranger };
}

/**
 * A created match whose betting window is open. These suites exercise the GENERIC categorical-prop
 * machinery every market shares (betting guards, escrow, mid-match close, refund) through the round-1
 * RoundVotedOut market at propIdx 0 — one uniform `Prop` path backs every kind, so it stands in for all
 * of them. Kind-specific SETTLEMENT lives in the per-kind suites (votedout / nightkill / detectiveclaim /
 * mafiaseat / faction). The per-seat PlayerFate/survival market is not floated for now.
 */
async function opened(nonce: string, n = 5) {
  const ctx = await deploy();
  const teeSigner = ethers.Wallet.createRandom();
  const fx = await buildSettlement(SEED, n, nonce, teeSigner);
  const sched = await defaultSchedule(ethers.provider);
  await ctx.market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: n, schedule: sched }));
  await mineUpTo(sched.bettingOpenBlock);
  const PROP = 0;            // the round-1 RoundVotedOut market — minted first
  const numOutcomes = n + 1; // seat 0..n-1 + "no one"
  return { ...ctx, fx, sched, teeSigner, matchId: 0, n, PROP, numOutcomes };
}

describe("MafiaMarket — categorical prop mechanics (generic): creation", () => {
  it("mints exactly the two round-1 markets (RoundVotedOut at 0, NightKill at 1), empty/Unset", async () => {
    const { market, numOutcomes } = await opened("gp-create");
    expect(await market.propCount(0)).to.equal(2); // no per-seat PlayerFate market is floated
    const vo = await market.getProp(0, 0);
    expect(vo.kind).to.equal(KIND.RoundVotedOut);
    expect(vo.param).to.equal(1);
    expect(vo.numOutcomes).to.equal(numOutcomes);
    expect(vo.pools.length).to.equal(numOutcomes);
    for (const p of vo.pools) expect(p).to.equal(0);
    expect(vo.closed).to.equal(false);
    expect(vo.state).to.equal(PS.Unset);
    expect((await market.getProp(0, 1)).kind).to.equal(KIND.NightKill);
  });
});

describe("MafiaMarket — categorical prop mechanics (generic): betting", () => {
  it("accumulates per-outcome pools + stakes and emits PropBetPlaced; pulls CHIP into escrow", async () => {
    const { market, token, alice, bob, PROP } = await opened("gp-bet");
    const before = await token.balanceOf(await market.getAddress());
    // alice on outcome 0, bob on outcome 2, alice tops up outcome 0.
    await expect(market.connect(alice).betProp(0, PROP, 0, ethers.parseEther("1")))
      .to.emit(market, "PropBetPlaced");
    await market.connect(bob).betProp(0, PROP, 2, ethers.parseEther("3"));
    await market.connect(alice).betProp(0, PROP, 0, ethers.parseEther("0.5"));

    const pr = await market.getProp(0, PROP);
    expect(pr.pools[0]).to.equal(ethers.parseEther("1.5"));
    expect(pr.pools[2]).to.equal(ethers.parseEther("3"));
    expect(pr.pools[1]).to.equal(0);
    expect(await market.propStake(0, PROP, 0, alice.address)).to.equal(ethers.parseEther("1.5"));
    expect(await market.propStake(0, PROP, 2, bob.address)).to.equal(ethers.parseEther("3"));
    const after = await token.balanceOf(await market.getAddress());
    expect(after - before).to.equal(ethers.parseEther("4.5"));
  });

  it("enforces MIN_BET / MAX_BET_PER_TX, a valid outcome, and a valid propIdx", async () => {
    const { market, alice, PROP, numOutcomes } = await opened("gp-guards");
    await expect(market.connect(alice).betProp(0, PROP, 0, ethers.parseEther("0.001"))).to.be.revertedWith("below min bet");
    await expect(market.connect(alice).betProp(0, PROP, 0, ethers.parseEther("10001"))).to.be.revertedWith("above max bet");
    await expect(market.connect(alice).betProp(0, PROP, numOutcomes, ethers.parseEther("1"))).to.be.revertedWith("bad outcome"); // outcome == numOutcomes
    await expect(market.connect(alice).betProp(0, 99, 0, ethers.parseEther("1"))).to.be.reverted; // array OOB propIdx
  });

  it("reverts a prop bet before the window opens and after the deadline", async () => {
    const ctx = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "gp-window", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await ctx.market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "gp-window", playerCount: 5, schedule: sched }));
    await expect(ctx.market.connect(ctx.alice).betProp(0, 0, 0, ethers.parseEther("1"))).to.be.revertedWith("betting not started");
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await expect(ctx.market.connect(ctx.alice).betProp(0, 0, 0, ethers.parseEther("1"))).to.be.revertedWith("betting closed");
  });

  it("reverts claimProp before the match is settled", async () => {
    const { market, alice, PROP } = await opened("gp-early");
    await market.connect(alice).betProp(0, PROP, 0, ethers.parseEther("1"));
    await expect(market.connect(alice).claimProp(0, PROP)).to.be.revertedWith("not settled");
  });
});

describe("MafiaMarket — categorical prop mechanics (generic): mid-match close", () => {
  it("freezes a single market's betting once the host closes it (no betting a decided market)", async () => {
    const { market, owner, alice, PROP } = await opened("gp-close");
    await market.connect(alice).betProp(0, PROP, 1, ethers.parseEther("1")); // ok while open
    await expect(market.connect(owner).closeProp(0, PROP)).to.emit(market, "PropClosed").withArgs(0, PROP);
    expect((await market.getProp(0, PROP)).closed).to.equal(true);
    await expect(market.connect(alice).betProp(0, PROP, 0, ethers.parseEther("1"))).to.be.revertedWith("prop closed");
    await expect(market.connect(alice).betProp(0, PROP, 2, ethers.parseEther("1"))).to.be.revertedWith("prop closed");
    // a different, open market (NightKill r1 at propIdx 1) is unaffected
    await expect(market.connect(alice).betProp(0, 1, 0, ethers.parseEther("1"))).to.emit(market, "PropBetPlaced");
  });

  it("is owner-only and idempotent", async () => {
    const { market, owner, alice, PROP } = await opened("gp-close-auth");
    await expect(market.connect(alice).closeProp(0, PROP)).to.be.revertedWith("not owner");
    await market.connect(owner).closeProp(0, PROP);
    await market.connect(owner).closeProp(0, PROP); // second close is a no-op (no revert, stays closed)
    expect((await market.getProp(0, PROP)).closed).to.equal(true);
  });

  it("reverts closeProp once the match is no longer open", async () => {
    const { market, owner, fx, PROP } = await opened("gp-close-late");
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    await expect(market.connect(owner).closeProp(0, PROP)).to.be.revertedWith("not open");
  });
});

describe("MafiaMarket — categorical prop mechanics (generic): refund mode", () => {
  it("refundProp returns the full stake (summed across outcomes) once the abandoned match enters RefundMode", async () => {
    const { market, token, alice, sched, PROP } = await opened("gp-refund");
    // Stake on two different outcomes of the same market — refundProp returns their sum.
    await market.connect(alice).betProp(0, PROP, 0, ethers.parseEther("2"));
    await market.connect(alice).betProp(0, PROP, 3, ethers.parseEther("1"));
    // before the deadline refundProp is unavailable
    await expect(market.connect(alice).refundProp(0, PROP)).to.be.revertedWith("not refund mode");
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(0);

    const before = await token.balanceOf(alice.address);
    await expect(market.connect(alice).refundProp(0, PROP)).to.emit(market, "PropRefunded");
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("3"));
    await expect(market.connect(alice).refundProp(0, PROP)).to.be.revertedWith("already refunded");
  });
});
