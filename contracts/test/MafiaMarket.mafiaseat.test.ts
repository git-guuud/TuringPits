import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, deployMarket, fundBettors, buildSettlement } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

// PropKind enum (MafiaMarket.sol): PlayerFate=0, RoundVotedOut=1, NightKill=2, DetectiveClaim=3, MafiaSeat=4.
const KIND = { PlayerFate: 0, RoundVotedOut: 1, NightKill: 2, DetectiveClaim: 3, MafiaSeat: 4 } as const;
// PropState enum (MafiaMarket.sol): Unset=0, Resolved=1, Void=2.
const PS = { Unset: 0, Resolved: 1, Void: 2 } as const;
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
  // createMatch mints props[0..n-1] PlayerFate, props[n] RoundVotedOut r1, props[n+1] NightKill r1.
  // The "Who is the Mafia?" market is NOT created up front — it is floated on demand and appends at the
  // tail, so with nothing else opened it lands at propIdx n+2.
  const mafiaSeat = fx.roles.findIndex((r) => r === ROLE.MAFIA);
  const townSeat = fx.roles.findIndex((r) => r !== ROLE.MAFIA);
  return { ...ctx, fx, sched, teeSigner, matchId: 0, n, mafiaSeat, townSeat };
}

describe("MafiaMarket — 'Who is the Mafia?' side market (props): creation on demand", () => {
  it("is NOT created up front — createMatch still mints exactly playerCount + 2 props, flag unset", async () => {
    const { market, n } = await opened("ms-create");
    expect(await market.propCount(0)).to.equal(n + 2); // n PlayerFate + VO r1 + NK r1, no MafiaSeat yet
    expect(await market.mafiaSeatOpened(0)).to.equal(false);
    // no prop is a MafiaSeat before it is floated
    const count = Number(await market.propCount(0));
    for (let i = 0; i < count; i++) expect(Number((await market.getProp(0, i)).kind)).to.not.equal(KIND.MafiaSeat);
  });

  it("openMafiaSeatMarket appends ONE categorical market with one outcome per seat and flips the guard", async () => {
    const { market, owner, n } = await opened("ms-open");
    const idx = Number(await market.propCount(0)); // tail == n+2
    await expect(market.connect(owner).openMafiaSeatMarket(0))
      .to.emit(market, "MafiaSeatMarketOpened").withArgs(0, idx);
    expect(await market.mafiaSeatOpened(0)).to.equal(true);
    expect(await market.propCount(0)).to.equal(n + 3);
    const pr = await market.getProp(0, idx);
    expect(pr.kind).to.equal(KIND.MafiaSeat);
    expect(pr.param).to.equal(0);              // param unused for this kind
    expect(pr.numOutcomes).to.equal(n);        // one outcome per seat
    expect(pr.pools.length).to.equal(n);
    for (const p of pr.pools) expect(p).to.equal(0);
    expect(pr.closed).to.equal(false);
    expect(pr.state).to.equal(PS.Unset);
  });

  it("opens at most ONCE — a second call reverts instead of minting a second market", async () => {
    const { market, owner } = await opened("ms-once");
    await market.connect(owner).openMafiaSeatMarket(0);
    await expect(market.connect(owner).openMafiaSeatMarket(0)).to.be.revertedWith("already opened");
  });

  it("is owner-only and refuses to open once the match is no longer accepting bets", async () => {
    const { market, stranger, fx } = await opened("ms-auth");
    await expect(market.connect(stranger).openMafiaSeatMarket(0)).to.be.revertedWith("not owner");
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    await expect(market.openMafiaSeatMarket(0)).to.be.revertedWith("not open");
  });
});

describe("MafiaMarket — 'Who is the Mafia?' side market (props): betting", () => {
  it("accumulates per-outcome pools independently of the fate/round markets", async () => {
    const { market, owner, alice, bob, mafiaSeat, townSeat } = await opened("ms-bet");
    const idx = Number(await market.propCount(0));
    await market.connect(owner).openMafiaSeatMarket(0);
    await expect(market.connect(alice).betProp(0, idx, mafiaSeat, ethers.parseEther("1")))
      .to.emit(market, "PropBetPlaced");
    await market.connect(bob).betProp(0, idx, townSeat, ethers.parseEther("3"));

    const pr = await market.getProp(0, idx);
    expect(pr.pools[mafiaSeat]).to.equal(ethers.parseEther("1"));
    expect(pr.pools[townSeat]).to.equal(ethers.parseEther("3"));
    expect(await market.propStake(0, idx, mafiaSeat, alice.address)).to.equal(ethers.parseEther("1"));
    // a seat's own PlayerFate market is untouched
    expect((await market.getProp(0, 0)).pools[0]).to.equal(0);
  });

  it("refuses an out-of-range outcome (only seats 0..playerCount-1 exist)", async () => {
    const { market, owner, alice, n } = await opened("ms-badout");
    const idx = Number(await market.propCount(0));
    await market.connect(owner).openMafiaSeatMarket(0);
    await expect(market.connect(alice).betProp(0, idx, n, ethers.parseEther("1"))).to.be.revertedWith("bad outcome");
  });
});

describe("MafiaMarket — 'Who is the Mafia?' side market (props): settlement from verified roles", () => {
  it("resolves to the seat whose revealed role is MAFIA (even if that seat was killed)", async () => {
    const { market, alice, bob, fx, mafiaSeat, townSeat } = await opened("ms-resolve");
    expect(fx.roles[mafiaSeat]).to.equal(ROLE.MAFIA);
    const idx = Number(await market.propCount(0));
    await market.openMafiaSeatMarket(0);
    await market.connect(alice).betProp(0, idx, mafiaSeat, ethers.parseEther("1")); // wins
    await market.connect(bob).betProp(0, idx, townSeat, ethers.parseEther("1"));    // loses
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    const pr = await market.getProp(0, idx);
    expect(pr.state).to.equal(PS.Resolved);
    expect(pr.winningOutcome).to.equal(mafiaSeat);
    expect(pr.winningPool).to.equal(ethers.parseEther("1"));
    expect(pr.netPot).to.equal(ethers.parseEther("1.96")); // gross 2, fee 2% = 0.04
  });

  it("pays the Mafia-seat backers pro-rata via claimProp; blocks double / loser claim", async () => {
    const { market, token, alice, bob, carol, fx, mafiaSeat, townSeat } = await opened("ms-claim");
    const idx = Number(await market.propCount(0));
    await market.openMafiaSeatMarket(0);
    await market.connect(alice).betProp(0, idx, mafiaSeat, ethers.parseEther("1"));
    await market.connect(carol).betProp(0, idx, mafiaSeat, ethers.parseEther("2"));
    await market.connect(bob).betProp(0, idx, townSeat, ethers.parseEther("3")); // loser
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.getProp(0, idx)).winningOutcome).to.equal(mafiaSeat);

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

  it("Voids when nobody backed the Mafia seat, and refunds via claimProp", async () => {
    const { market, token, alice, fx, townSeat } = await opened("ms-void");
    const idx = Number(await market.propCount(0));
    await market.openMafiaSeatMarket(0);
    await market.connect(alice).betProp(0, idx, townSeat, ethers.parseEther("2")); // only a town seat backed → Void
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.getProp(0, idx)).state).to.equal(PS.Void);

    const before = await token.balanceOf(alice.address);
    await expect(market.connect(alice).claimProp(0, idx)).to.emit(market, "PropClaimed");
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("2")); // full refund
  });
});
