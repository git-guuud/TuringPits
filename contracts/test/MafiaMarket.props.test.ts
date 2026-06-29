import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, deployMarket, fundBettors, buildSettlement } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

// PropKind enum (MafiaMarket.sol): PlayerFate=0, RoundVotedOut=1.
const KIND = { PlayerFate: 0, RoundVotedOut: 1 } as const;
// PropState enum (MafiaMarket.sol): Unset=0, Resolved=1, Void=2.
const PS = { Unset: 0, Resolved: 1, Void: 2 } as const;
// PlayerFate outcome buckets (MafiaMarket.FATE_BUCKETS == 5):
//   0 survives · 1 out R1 · 2 out R2 · 3 out R3 · 4 out R4+ (death round >= 4).
const FATE_BUCKETS = 5;
const fateBucket = (deathRound: number) => (deathRound >= FATE_BUCKETS - 1 ? FATE_BUCKETS - 1 : deathRound);

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
  // PlayerFate is the first block: propIdx == seat. The single round-1 RoundVotedOut market lives at n.
  const fateIdx = (seat: number) => seat;
  // The bucket each seat's fate market resolves to (== engine truth from deathRound).
  const fateWin = (seat: number) => fateBucket(fx.deathRound[seat]);
  return { ...ctx, fx, sched, teeSigner, matchId: 0, n, fateIdx, fateWin };
}

describe("MafiaMarket — player-fate side markets (props): creation", () => {
  it("auto-creates one PlayerFate market per seat (index == seat == param), 5 outcomes, empty/Unset", async () => {
    const { market, n } = await opened("pf-create");
    // PlayerFate occupies props[0..n-1]; the round-1 RoundVotedOut market at props[n] is its own suite.
    expect(await market.propCount(0)).to.equal(n + 1);
    for (let i = 0; i < n; i++) {
      const pr = await market.getProp(0, i);
      expect(pr.kind, `seat ${i}`).to.equal(KIND.PlayerFate);
      expect(pr.param).to.equal(i);
      expect(pr.numOutcomes).to.equal(FATE_BUCKETS);
      expect(pr.closed).to.equal(false);
      expect(pr.state).to.equal(PS.Unset);
      expect(pr.pools.length).to.equal(FATE_BUCKETS);
      for (const p of pr.pools) expect(p).to.equal(0);
    }
  });

  it("emits PropsCreated with the total side-market count (n PlayerFate + 1 round-1 vote) and scales with playerCount", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    const commit = "0x" + "aa".repeat(32);
    // 7 seats → 7 PlayerFate + 1 round-1 RoundVotedOut = 8 side markets at creation.
    await expect(market.createMatch(createParams({ roleCommit: commit, teeSigner: teeSigner.address, nonce: "pf-7", playerCount: 7, schedule: sched })))
      .to.emit(market, "PropsCreated").withArgs(0, 8);
    expect(await market.propCount(0)).to.equal(8);
    // The round-1 RoundVotedOut market sits last with playerCount + 1 outcomes.
    const vo = await market.getProp(0, 7);
    expect(vo.kind).to.equal(KIND.RoundVotedOut);
    expect(vo.param).to.equal(1);
    expect(vo.numOutcomes).to.equal(8);
  });
});

describe("MafiaMarket — player-fate side markets (props): betting", () => {
  it("accumulates per-outcome pools + stakes and emits PropBetPlaced; pulls CHIP into escrow", async () => {
    const { market, token, alice, bob } = await opened("pf-bet");
    const before = await token.balanceOf(await market.getAddress());
    // Stake on seat 2's market: alice on outcome 0 (survives), bob on outcome 2 (out R2).
    await expect(market.connect(alice).betProp(0, 2, 0, ethers.parseEther("1")))
      .to.emit(market, "PropBetPlaced");
    await market.connect(bob).betProp(0, 2, 2, ethers.parseEther("3"));
    await market.connect(alice).betProp(0, 2, 0, ethers.parseEther("0.5"));

    const pr = await market.getProp(0, 2);
    expect(pr.pools[0]).to.equal(ethers.parseEther("1.5"));
    expect(pr.pools[2]).to.equal(ethers.parseEther("3"));
    expect(pr.pools[1]).to.equal(0);
    expect(await market.propStake(0, 2, 0, alice.address)).to.equal(ethers.parseEther("1.5"));
    expect(await market.propStake(0, 2, 2, bob.address)).to.equal(ethers.parseEther("3"));
    // a different seat's market is untouched
    expect((await market.getProp(0, 0)).pools[0]).to.equal(0);
    const after = await token.balanceOf(await market.getAddress());
    expect(after - before).to.equal(ethers.parseEther("4.5"));
  });

  it("enforces MIN_BET / MAX_BET_PER_TX, a valid outcome, and a valid propIdx", async () => {
    const { market, alice } = await opened("pf-guards");
    await expect(market.connect(alice).betProp(0, 0, 0, ethers.parseEther("0.001"))).to.be.revertedWith("below min bet");
    await expect(market.connect(alice).betProp(0, 0, 0, ethers.parseEther("10001"))).to.be.revertedWith("above max bet");
    await expect(market.connect(alice).betProp(0, 0, 5, ethers.parseEther("1"))).to.be.revertedWith("bad outcome"); // outcome == numOutcomes
    await expect(market.connect(alice).betProp(0, 99, 0, ethers.parseEther("1"))).to.be.reverted; // array OOB propIdx
  });

  it("reverts a prop bet before the window opens and after the deadline", async () => {
    const ctx = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "pf-window", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await ctx.market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "pf-window", playerCount: 5, schedule: sched }));
    await expect(ctx.market.connect(ctx.alice).betProp(0, 0, 0, ethers.parseEther("1"))).to.be.revertedWith("betting not started");
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await expect(ctx.market.connect(ctx.alice).betProp(0, 0, 0, ethers.parseEther("1"))).to.be.revertedWith("betting closed");
  });
});

describe("MafiaMarket — player-fate side markets (props): settlement", () => {
  it("resolves EVERY seat's fate market to its death-round bucket (== engine truth)", async () => {
    const { market, alice, bob, fx, n, fateWin } = await opened("pf-settle");
    // sanity: the scripted match is decisive (it has both survivors and casualties)
    expect(fx.alive.some((a) => a)).to.equal(true);
    expect(fx.alive.some((a) => !a)).to.equal(true);
    // Fund the winning bucket + one other on every seat so each resolves (never Void) — a clean
    // cross-check of on-chain g.deathRound against the engine, bucket by bucket.
    for (let seat = 0; seat < n; seat++) {
      const win = fateWin(seat);
      const other = win === 0 ? 1 : 0;
      await market.connect(alice).betProp(0, seat, win, ethers.parseEther("1"));
      await market.connect(bob).betProp(0, seat, other, ethers.parseEther("1"));
    }
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    for (let seat = 0; seat < n; seat++) {
      const pr = await market.getProp(0, seat);
      expect(pr.state, `seat ${seat}`).to.equal(PS.Resolved);
      expect(pr.winningOutcome, `seat ${seat}`).to.equal(fateWin(seat));
      expect(pr.winningPool).to.equal(ethers.parseEther("1"));
      // gross 2, fee 2% = 0.04, netPot 1.96
      expect(pr.netPot).to.equal(ethers.parseEther("1.96"));
    }
  });

  it("Voids a fate market when nobody backed the winning bucket, and refunds via claimProp", async () => {
    const { market, token, alice, fx, fateWin } = await opened("pf-void");
    const seat = 0;
    const win = fateWin(seat);
    const other = win === 0 ? 1 : 0;
    // Only a losing bucket is funded → winning pool empty → Void.
    await market.connect(alice).betProp(0, seat, other, ethers.parseEther("2"));
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.getProp(0, seat)).state).to.equal(PS.Void);

    const before = await token.balanceOf(alice.address);
    await expect(market.connect(alice).claimProp(0, seat)).to.emit(market, "PropClaimed");
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("2")); // full refund
  });

  it("pays the winning bucket's backers pro-rata via claimProp and blocks double-claim / loser claim", async () => {
    const { market, token, alice, bob, carol, fx, fateWin } = await opened("pf-claim");
    const seat = 0;
    const win = fateWin(seat);
    const other = win === 0 ? 1 : 0;
    await market.connect(alice).betProp(0, seat, win, ethers.parseEther("1"));
    await market.connect(carol).betProp(0, seat, win, ethers.parseEther("2"));
    await market.connect(bob).betProp(0, seat, other, ethers.parseEther("3")); // loser
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.getProp(0, seat)).winningOutcome).to.equal(win);

    // net pot = (1+2+3) - 2% = 5.88; winning pool = 3. alice: 5.88*1/3 = 1.96, carol: 3.92.
    const a0 = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(0, seat);
    expect((await token.balanceOf(alice.address)) - a0).to.equal(ethers.parseEther("1.96"));

    const c0 = await token.balanceOf(carol.address);
    await market.connect(carol).claimProp(0, seat);
    expect((await token.balanceOf(carol.address)) - c0).to.equal(ethers.parseEther("3.92"));

    await expect(market.connect(alice).claimProp(0, seat)).to.be.revertedWith("already claimed");
    await expect(market.connect(bob).claimProp(0, seat)).to.be.revertedWith("no winning stake");
  });

  it("reverts claimProp before the match is settled", async () => {
    const { market, alice, fateWin } = await opened("pf-early");
    await market.connect(alice).betProp(0, 0, fateWin(0), ethers.parseEther("1"));
    await expect(market.connect(alice).claimProp(0, 0)).to.be.revertedWith("not settled");
  });
});

describe("MafiaMarket — player-fate side markets (props): mid-match close", () => {
  it("freezes a single market's betting once the host closes it (no betting a decided seat)", async () => {
    const { market, owner, alice } = await opened("pf-close");
    await market.connect(alice).betProp(0, 3, 1, ethers.parseEther("1")); // ok while open
    await expect(market.connect(owner).closeProp(0, 3)).to.emit(market, "PropClosed").withArgs(0, 3);
    expect((await market.getProp(0, 3)).closed).to.equal(true);
    await expect(market.connect(alice).betProp(0, 3, 0, ethers.parseEther("1"))).to.be.revertedWith("prop closed");
    await expect(market.connect(alice).betProp(0, 3, 2, ethers.parseEther("1"))).to.be.revertedWith("prop closed");
    // a different, open market is unaffected
    await expect(market.connect(alice).betProp(0, 0, 0, ethers.parseEther("1"))).to.emit(market, "PropBetPlaced");
  });

  it("is owner-only and idempotent", async () => {
    const { market, owner, alice } = await opened("pf-close-auth");
    await expect(market.connect(alice).closeProp(0, 1)).to.be.revertedWith("not owner");
    await market.connect(owner).closeProp(0, 1);
    await market.connect(owner).closeProp(0, 1); // second close is a no-op (no revert, stays closed)
    expect((await market.getProp(0, 1)).closed).to.equal(true);
  });

  it("reverts closeProp once the match is no longer open", async () => {
    const { market, owner, fx } = await opened("pf-close-late");
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    await expect(market.connect(owner).closeProp(0, 0)).to.be.revertedWith("not open");
  });

  it("a closed market still resolves from the verified run and pays existing stakes (payout-neutral)", async () => {
    const { market, token, owner, alice, bob, fx, fateWin } = await opened("pf-close-settle");
    const seat = 0;
    const win = fateWin(seat);
    const other = win === 0 ? 1 : 0;
    await market.connect(alice).betProp(0, seat, win, ethers.parseEther("1"));
    await market.connect(bob).betProp(0, seat, other, ethers.parseEther("1"));
    await market.connect(owner).closeProp(0, seat);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    const pr = await market.getProp(0, seat);
    expect(pr.closed).to.equal(true);
    expect(pr.state).to.equal(PS.Resolved);
    expect(pr.winningOutcome).to.equal(win); // resolves despite the freeze
    // gross 2, fee 2% = 0.04, netPot 1.96, winning pool = 1 → alice claims 1.96
    const before = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(0, seat);
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("1.96"));
  });
});

describe("MafiaMarket — player-fate side markets (props): refund mode", () => {
  it("refundProp returns the full stake (summed across outcomes) once the abandoned match enters RefundMode", async () => {
    const { market, token, alice, sched } = await opened("pf-refund");
    // Stake on two different buckets of the same seat — refundProp returns their sum.
    await market.connect(alice).betProp(0, 1, 0, ethers.parseEther("2"));
    await market.connect(alice).betProp(0, 1, 3, ethers.parseEther("1"));
    // before the deadline refundProp is unavailable
    await expect(market.connect(alice).refundProp(0, 1)).to.be.revertedWith("not refund mode");
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(0);

    const before = await token.balanceOf(alice.address);
    await expect(market.connect(alice).refundProp(0, 1)).to.emit(market, "PropRefunded");
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("3"));
    await expect(market.connect(alice).refundProp(0, 1)).to.be.revertedWith("already refunded");
  });
});
