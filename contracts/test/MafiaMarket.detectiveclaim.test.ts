import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, deployMarket, fundBettors, buildSettlement } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

// PropKind enum (MafiaMarket.sol): PlayerFate=0, RoundVotedOut=1, NightKill=2, DetectiveClaim=3.
const KIND = { PlayerFate: 0, RoundVotedOut: 1, NightKill: 2, DetectiveClaim: 3 } as const;
// PropState enum (MafiaMarket.sol): Unset=0, Resolved=1, Void=2.
const PS = { Unset: 0, Resolved: 1, Void: 2 } as const;
// DetectiveClaim outcomes: 0 = BLUFF (fake claim), 1 = REAL DETECTIVE.
const OUT = { BLUFF: 0, REAL: 1 } as const;
// Role enum (== helpers/market ROLE_ENUM): MAFIA=0, DOCTOR=1, DETECTIVE=2, TOWN=3.
const ROLE = { MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 } as const;

async function deploy() {
  const [owner, treasury, alice, bob, carol, stranger] = await ethers.getSigners();
  const { market, token } = await deployMarket(owner, treasury);
  await fundBettors(token, await market.getAddress(), [alice, bob, carol, stranger]);
  return { market, token, owner, treasury, alice, bob, carol, stranger };
}

/** A created match whose betting window is open, with a real scripted settlement in hand. */
async function opened(nonce: string, n = 6) {
  const ctx = await deploy();
  const teeSigner = ethers.Wallet.createRandom();
  const fx = await buildSettlement(SEED, n, nonce, teeSigner);
  const sched = await defaultSchedule(ethers.provider);
  await ctx.market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: n, schedule: sched }));
  await mineUpTo(sched.bettingOpenBlock);
  // createMatch mints props[0] RoundVotedOut r1, props[1] NightKill r1 (no per-seat PlayerFate market).
  // The DetectiveClaim market is NOT created up front — it is floated on demand and appends at the
  // tail, so with nothing else opened it lands at propIdx 2.
  const detSeat = fx.roles.findIndex((r) => r === ROLE.DETECTIVE);
  const mafiaSeat = fx.roles.findIndex((r) => r === ROLE.MAFIA);
  return { ...ctx, fx, sched, teeSigner, matchId: 0, n, detSeat, mafiaSeat };
}

describe("MafiaMarket — 'Detective claim: real or bluff?' side market (props): creation on demand", () => {
  it("is NOT created up front — createMatch still mints exactly 2 props, flag unset", async () => {
    const { market, n } = await opened("dc-create");
    expect(await market.propCount(0)).to.equal(2); // VO r1 + NK r1, no DetectiveClaim yet
    expect(await market.detectiveClaimOpened(0)).to.equal(false);
    // no prop is a DetectiveClaim before it is floated
    const count = Number(await market.propCount(0));
    for (let i = 0; i < count; i++) expect(Number((await market.getProp(0, i)).kind)).to.not.equal(KIND.DetectiveClaim);
  });

  it("openDetectiveClaim appends ONE binary market tagged with the claiming seat and flips the guard", async () => {
    const { market, owner, n, detSeat } = await opened("dc-open");
    const idx = Number(await market.propCount(0)); // tail == 2
    await expect(market.connect(owner).openDetectiveClaim(0, detSeat))
      .to.emit(market, "DetectiveClaimOpened").withArgs(0, idx, detSeat);
    expect(await market.detectiveClaimOpened(0)).to.equal(true);
    expect(await market.propCount(0)).to.equal(3);
    const pr = await market.getProp(0, idx);
    expect(pr.kind).to.equal(KIND.DetectiveClaim);
    expect(pr.param).to.equal(detSeat);       // param carries the claiming seat
    expect(pr.numOutcomes).to.equal(2);        // binary: BLUFF / REAL
    expect(pr.pools.length).to.equal(2);
    for (const p of pr.pools) expect(p).to.equal(0);
    expect(pr.closed).to.equal(false);
    expect(pr.state).to.equal(PS.Unset);
  });

  it("opens at most ONCE — a second claim (e.g. a Mafia counter-claim) reverts instead of a new market", async () => {
    const { market, owner, detSeat, mafiaSeat } = await opened("dc-once");
    await market.connect(owner).openDetectiveClaim(0, detSeat);
    await expect(market.connect(owner).openDetectiveClaim(0, mafiaSeat)).to.be.revertedWith("already opened");
    await expect(market.connect(owner).openDetectiveClaim(0, detSeat)).to.be.revertedWith("already opened");
  });

  it("rejects a seat outside the table", async () => {
    const { market, owner, n } = await opened("dc-oob");
    await expect(market.connect(owner).openDetectiveClaim(0, n)).to.be.revertedWith("bad seat");
    await expect(market.connect(owner).openDetectiveClaim(0, 200)).to.be.revertedWith("bad seat");
  });

  it("is owner-only and refuses to open once the match is no longer accepting bets", async () => {
    const { market, stranger, fx, detSeat } = await opened("dc-auth");
    await expect(market.connect(stranger).openDetectiveClaim(0, detSeat)).to.be.revertedWith("not owner");
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    await expect(market.openDetectiveClaim(0, detSeat)).to.be.revertedWith("not open");
  });
});

describe("MafiaMarket — 'Detective claim' side market (props): betting", () => {
  it("accumulates per-outcome pools independently of the round markets", async () => {
    const { market, owner, alice, bob, detSeat, n } = await opened("dc-bet");
    const idx = Number(await market.propCount(0));
    await market.connect(owner).openDetectiveClaim(0, detSeat);
    await expect(market.connect(alice).betProp(0, idx, OUT.REAL, ethers.parseEther("1")))
      .to.emit(market, "PropBetPlaced");
    await market.connect(bob).betProp(0, idx, OUT.BLUFF, ethers.parseEther("3"));

    const pr = await market.getProp(0, idx);
    expect(pr.pools[OUT.REAL]).to.equal(ethers.parseEther("1"));
    expect(pr.pools[OUT.BLUFF]).to.equal(ethers.parseEther("3"));
    expect(await market.propStake(0, idx, OUT.REAL, alice.address)).to.equal(ethers.parseEther("1"));
    // the round-1 RoundVotedOut market (propIdx 0) is untouched
    expect((await market.getProp(0, 0)).pools[0]).to.equal(0);
  });

  it("refuses an out-of-range outcome (binary market has only 0/1)", async () => {
    const { market, owner, alice, detSeat } = await opened("dc-badout");
    const idx = Number(await market.propCount(0));
    await market.connect(owner).openDetectiveClaim(0, detSeat);
    await expect(market.connect(alice).betProp(0, idx, 2, ethers.parseEther("1"))).to.be.revertedWith("bad outcome");
  });
});

describe("MafiaMarket — 'Detective claim' side market (props): settlement from verified roles", () => {
  it("resolves REAL when the claiming seat's revealed role is DETECTIVE (even if that seat was killed)", async () => {
    const { market, alice, bob, fx, detSeat } = await opened("dc-real");
    expect(fx.roles[detSeat]).to.equal(ROLE.DETECTIVE);
    const idx = Number(await market.propCount(0));
    await market.openDetectiveClaim(0, detSeat);
    await market.connect(alice).betProp(0, idx, OUT.REAL, ethers.parseEther("1"));  // wins
    await market.connect(bob).betProp(0, idx, OUT.BLUFF, ethers.parseEther("1"));   // loses
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    const pr = await market.getProp(0, idx);
    expect(pr.state).to.equal(PS.Resolved);
    expect(pr.winningOutcome).to.equal(OUT.REAL);
    expect(pr.winningPool).to.equal(ethers.parseEther("1"));
    expect(pr.netPot).to.equal(ethers.parseEther("1.96")); // gross 2, fee 2% = 0.04
  });

  it("resolves BLUFF when the claiming seat's revealed role is NOT the Detective (a Mafia fake-claim)", async () => {
    const { market, alice, bob, fx, mafiaSeat } = await opened("dc-bluff");
    expect(fx.roles[mafiaSeat]).to.not.equal(ROLE.DETECTIVE);
    const idx = Number(await market.propCount(0));
    await market.openDetectiveClaim(0, mafiaSeat); // the Mafia went public as "Detective"
    await market.connect(alice).betProp(0, idx, OUT.BLUFF, ethers.parseEther("1")); // wins
    await market.connect(bob).betProp(0, idx, OUT.REAL, ethers.parseEther("1"));    // loses
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    const pr = await market.getProp(0, idx);
    expect(pr.state).to.equal(PS.Resolved);
    expect(pr.winningOutcome).to.equal(OUT.BLUFF);
  });

  it("pays REAL backers pro-rata via claimProp; blocks double / loser claim", async () => {
    const { market, token, alice, bob, carol, fx, detSeat } = await opened("dc-claim");
    const idx = Number(await market.propCount(0));
    await market.openDetectiveClaim(0, detSeat);
    await market.connect(alice).betProp(0, idx, OUT.REAL, ethers.parseEther("1"));
    await market.connect(carol).betProp(0, idx, OUT.REAL, ethers.parseEther("2"));
    await market.connect(bob).betProp(0, idx, OUT.BLUFF, ethers.parseEther("3")); // loser
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.getProp(0, idx)).winningOutcome).to.equal(OUT.REAL);

    // net pot = (1+2+3) - 2% = 5.88; winning pool = 3. alice: 5.88*1/3 = 1.96, carol: 3.92.
    const a0 = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(0, idx);
    expect((await token.balanceOf(alice.address)) - a0).to.equal(ethers.parseEther("1.96"));
    const c0 = await token.balanceOf(carol.address);
    await market.connect(carol).claimProp(0, idx);
    expect((await token.balanceOf(carol.address)) - c0).to.equal(ethers.parseEther("3.92"));

    await expect(market.connect(alice).claimProp(0, idx)).to.be.revertedWith("already claimed");
    await expect(market.connect(bob).claimProp(0, idx)).to.be.revertedWith("no winning stake");
  });

  it("Voids when nobody backed the winning outcome, and refunds via claimProp", async () => {
    const { market, token, alice, fx, detSeat } = await opened("dc-void");
    const idx = Number(await market.propCount(0));
    await market.openDetectiveClaim(0, detSeat); // truth is REAL...
    await market.connect(alice).betProp(0, idx, OUT.BLUFF, ethers.parseEther("2")); // ...but only BLUFF backed → Void
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.getProp(0, idx)).state).to.equal(PS.Void);

    const before = await token.balanceOf(alice.address);
    await expect(market.connect(alice).claimProp(0, idx)).to.emit(market, "PropClaimed");
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("2")); // full refund
  });
});

describe("MafiaMarket — 'Detective claim' side market (props): mid-match close", () => {
  it("stays open until the host freezes it, then still resolves from the verified run", async () => {
    const { market, token, owner, alice, bob, fx, detSeat } = await opened("dc-close");
    const idx = Number(await market.propCount(0));
    await market.openDetectiveClaim(0, detSeat);
    await market.connect(alice).betProp(0, idx, OUT.REAL, ethers.parseEther("1"));
    await market.connect(bob).betProp(0, idx, OUT.BLUFF, ethers.parseEther("1"));
    // The host CAN freeze it (e.g. at match end), but nothing forces it closed mid-match.
    await expect(market.connect(owner).closeProp(0, idx)).to.emit(market, "PropClosed").withArgs(0, idx);
    await expect(market.connect(alice).betProp(0, idx, OUT.REAL, ethers.parseEther("1"))).to.be.revertedWith("prop closed");

    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    const pr = await market.getProp(0, idx);
    expect(pr.closed).to.equal(true);
    expect(pr.winningOutcome).to.equal(OUT.REAL); // resolves despite the freeze
    const before = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(0, idx);
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("1.96"));
  });
});
