import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, deployMarket, fundBettors, buildSettlement } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

// Outcome enum (MafiaTypes.sol): Unset=0, Yes=1, No=2, Draw=3, Void=4.
const OUT = { Unset: 0, Yes: 1, No: 2, Draw: 3, Void: 4 } as const;

async function deploy() {
  const [owner, treasury, alice, bob, carol, stranger] = await ethers.getSigners();
  const { market, token } = await deployMarket(owner, treasury);
  await fundBettors(token, await market.getAddress(), [alice, bob, carol, stranger]);
  return { market, token, owner, treasury, alice, bob, carol, stranger };
}

/** A created match whose betting window is open, with a real scripted settlement in hand. */
async function opened(nonce: string, n = 5) {
  const ctx = await deploy();
  const teeSigner = ethers.Wallet.createRandom();
  const fx = await buildSettlement(SEED, n, nonce, teeSigner);
  const sched = await defaultSchedule(ethers.provider);
  await ctx.market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: n, schedule: sched }));
  await mineUpTo(sched.bettingOpenBlock);
  return { ...ctx, fx, sched, teeSigner, matchId: 0, n };
}

describe("MafiaMarket — survival side markets (props): creation", () => {
  it("auto-creates one Survival prop per seat (index == seat == param), all empty/Unset", async () => {
    const { market, n } = await opened("p-create");
    expect(await market.propCount(0)).to.equal(n);
    for (let i = 0; i < n; i++) {
      const pr = await market.getProp(0, i);
      expect(pr.kind).to.equal(0); // PropKind.Survival
      expect(pr.param).to.equal(i);
      expect(pr.poolYes).to.equal(0);
      expect(pr.poolNo).to.equal(0);
      expect(pr.outcome).to.equal(OUT.Unset);
    }
  });

  it("emits PropsCreated with the seat count and scales with playerCount", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    const commit = "0x" + "aa".repeat(32);
    await expect(market.createMatch(createParams({ roleCommit: commit, teeSigner: teeSigner.address, nonce: "p-7", playerCount: 7, schedule: sched })))
      .to.emit(market, "PropsCreated").withArgs(0, 7);
    expect(await market.propCount(0)).to.equal(7);
  });
});

describe("MafiaMarket — survival side markets (props): betting", () => {
  it("accumulates pools + stakes and emits PropBetPlaced; pulls CHIP into escrow", async () => {
    const { market, token, alice, bob } = await opened("p-bet");
    const before = await token.balanceOf(await market.getAddress());
    await expect(market.connect(alice).betPropYes(0, 2, ethers.parseEther("1")))
      .to.emit(market, "PropBetPlaced");
    await market.connect(bob).betPropNo(0, 2, ethers.parseEther("3"));
    await market.connect(alice).betPropYes(0, 2, ethers.parseEther("0.5"));

    const pr = await market.getProp(0, 2);
    expect(pr.poolYes).to.equal(ethers.parseEther("1.5"));
    expect(pr.poolNo).to.equal(ethers.parseEther("3"));
    expect(await market.propStakeYes(0, 2, alice.address)).to.equal(ethers.parseEther("1.5"));
    expect(await market.propStakeNo(0, 2, bob.address)).to.equal(ethers.parseEther("3"));
    // a different prop is untouched
    expect((await market.getProp(0, 0)).poolYes).to.equal(0);
    const after = await token.balanceOf(await market.getAddress());
    expect(after - before).to.equal(ethers.parseEther("4.5"));
  });

  it("enforces MIN_BET / MAX_BET_PER_TX and reverts an out-of-range propIdx", async () => {
    const { market, alice } = await opened("p-guards");
    await expect(market.connect(alice).betPropYes(0, 0, ethers.parseEther("0.001"))).to.be.revertedWith("below min bet");
    await expect(market.connect(alice).betPropYes(0, 0, ethers.parseEther("10001"))).to.be.revertedWith("above max bet");
    await expect(market.connect(alice).betPropYes(0, 99, ethers.parseEther("1"))).to.be.reverted; // array OOB
  });

  it("reverts a prop bet before the window opens and after the deadline", async () => {
    const ctx = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "p-window", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await ctx.market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "p-window", playerCount: 5, schedule: sched }));
    await expect(ctx.market.connect(ctx.alice).betPropYes(0, 0, ethers.parseEther("1"))).to.be.revertedWith("betting not started");
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await expect(ctx.market.connect(ctx.alice).betPropYes(0, 0, ethers.parseEther("1"))).to.be.revertedWith("betting closed");
  });
});

describe("MafiaMarket — survival side markets (props): settlement", () => {
  it("resolves EVERY survival prop to the engine's final alive set (survivor→Yes, dead→No)", async () => {
    const { market, alice, bob, fx, n } = await opened("p-settle");
    // Fund both sides of every seat's market so each resolves to Yes/No (never Void) — a clean
    // cross-check of on-chain g.alive against the engine's survival truth.
    for (let i = 0; i < n; i++) {
      await market.connect(alice).betPropYes(0, i, ethers.parseEther("1"));
      await market.connect(bob).betPropNo(0, i, ethers.parseEther("1"));
    }
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    // sanity: the scripted match is decisive (it has both survivors and casualties)
    expect(fx.alive.some((a) => a)).to.equal(true);
    expect(fx.alive.some((a) => !a)).to.equal(true);
    for (let i = 0; i < n; i++) {
      const pr = await market.getProp(0, i);
      expect(pr.outcome, `seat ${i}`).to.equal(fx.alive[i] ? OUT.Yes : OUT.No);
      expect(pr.winningPool).to.equal(ethers.parseEther("1"));
      // gross 2, fee 2% = 0.04, netPot 1.96
      expect(pr.netPot).to.equal(ethers.parseEther("1.96"));
    }
  });

  it("Voids a prop when nobody backed the winning side, and refunds via claimProp", async () => {
    const { market, token, alice, fx } = await opened("p-void");
    const dead = fx.alive.findIndex((a) => !a); // a seat that dies → NO wins
    // Only the (losing) YES side is funded → winning pool (NO) is empty → Void.
    await market.connect(alice).betPropYes(0, dead, ethers.parseEther("2"));
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.getProp(0, dead)).outcome).to.equal(OUT.Void);

    const before = await token.balanceOf(alice.address);
    await expect(market.connect(alice).claimProp(0, dead)).to.emit(market, "PropClaimed");
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("2")); // full refund
  });

  it("pays the winning side pro-rata via claimProp and blocks double-claim / loser claim", async () => {
    const { market, token, alice, bob, carol, fx } = await opened("p-claim");
    const surv = fx.alive.findIndex((a) => a); // a survivor → YES wins
    await market.connect(alice).betPropYes(0, surv, ethers.parseEther("1"));
    await market.connect(carol).betPropYes(0, surv, ethers.parseEther("2"));
    await market.connect(bob).betPropNo(0, surv, ethers.parseEther("3")); // loser
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.getProp(0, surv)).outcome).to.equal(OUT.Yes);

    // net pot = (1+2+3) - 2% = 5.88; winning pool (YES) = 3. alice: 5.88*1/3 = 1.96, carol: 3.92.
    const a0 = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(0, surv);
    expect((await token.balanceOf(alice.address)) - a0).to.equal(ethers.parseEther("1.96"));

    const c0 = await token.balanceOf(carol.address);
    await market.connect(carol).claimProp(0, surv);
    expect((await token.balanceOf(carol.address)) - c0).to.equal(ethers.parseEther("3.92"));

    await expect(market.connect(alice).claimProp(0, surv)).to.be.revertedWith("already claimed");
    await expect(market.connect(bob).claimProp(0, surv)).to.be.revertedWith("no winning stake");
  });

  it("reverts claimProp before the match is settled", async () => {
    const { market, alice, fx } = await opened("p-early");
    const surv = fx.alive.findIndex((a) => a);
    await market.connect(alice).betPropYes(0, surv, ethers.parseEther("1"));
    await expect(market.connect(alice).claimProp(0, surv)).to.be.revertedWith("not settled");
  });
});

describe("MafiaMarket — survival side markets (props): mid-match close", () => {
  it("freezes a single prop's betting once the host closes it (no betting a corpse)", async () => {
    const { market, owner, alice } = await opened("p-close");
    await market.connect(alice).betPropNo(0, 3, ethers.parseEther("1")); // ok while open
    await expect(market.connect(owner).closeProp(0, 3)).to.emit(market, "PropClosed").withArgs(0, 3);
    expect((await market.getProp(0, 3)).closed).to.equal(true);
    await expect(market.connect(alice).betPropNo(0, 3, ethers.parseEther("1"))).to.be.revertedWith("prop closed");
    await expect(market.connect(alice).betPropYes(0, 3, ethers.parseEther("1"))).to.be.revertedWith("prop closed");
    // a different, open prop is unaffected
    await expect(market.connect(alice).betPropYes(0, 0, ethers.parseEther("1"))).to.emit(market, "PropBetPlaced");
  });

  it("is owner-only and idempotent", async () => {
    const { market, owner, alice } = await opened("p-close-auth");
    await expect(market.connect(alice).closeProp(0, 1)).to.be.revertedWith("not owner");
    await market.connect(owner).closeProp(0, 1);
    await market.connect(owner).closeProp(0, 1); // second close is a no-op (no revert, stays closed)
    expect((await market.getProp(0, 1)).closed).to.equal(true);
  });

  it("reverts closeProp once the match is no longer open", async () => {
    const { market, owner, fx } = await opened("p-close-late");
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    await expect(market.connect(owner).closeProp(0, 0)).to.be.revertedWith("not open");
  });

  it("a closed prop still resolves from the verified run and pays existing stakes (payout-neutral)", async () => {
    const { market, token, owner, alice, bob, fx } = await opened("p-close-settle");
    const dead = fx.alive.findIndex((a) => !a); // a seat that falls → NO wins
    await market.connect(alice).betPropNo(0, dead, ethers.parseEther("1"));
    await market.connect(bob).betPropYes(0, dead, ethers.parseEther("1"));
    await market.connect(owner).closeProp(0, dead);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    const pr = await market.getProp(0, dead);
    expect(pr.closed).to.equal(true);
    expect(pr.outcome).to.equal(OUT.No); // NO (fell) wins despite the freeze
    // gross 2, fee 2% = 0.04, netPot 1.96, winning pool (NO) = 1 → alice claims 1.96
    const before = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(0, dead);
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("1.96"));
  });
});

describe("MafiaMarket — survival side markets (props): refund mode", () => {
  it("refundProp returns the full stake once the abandoned match enters RefundMode", async () => {
    const { market, token, alice, sched } = await opened("p-refund");
    await market.connect(alice).betPropYes(0, 1, ethers.parseEther("2"));
    // before the deadline refundProp is unavailable
    await expect(market.connect(alice).refundProp(0, 1)).to.be.revertedWith("not refund mode");
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(0);

    const before = await token.balanceOf(alice.address);
    await expect(market.connect(alice).refundProp(0, 1)).to.emit(market, "PropRefunded");
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("2"));
    await expect(market.connect(alice).refundProp(0, 1)).to.be.revertedWith("already refunded");
  });
});
