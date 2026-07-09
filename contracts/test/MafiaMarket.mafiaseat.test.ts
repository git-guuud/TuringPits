import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, deployMarket, fundBettors, buildSettlement, mafiaSeatIdx, PROP_KIND } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

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
  // createMatch seeds props[0] RoundVotedOut r1, props[1] NightKill r1, props[2] Faction and
  // props[3] MafiaSeat — the "Who is the Mafia?" market exists from block one, no post-create open
  // tx. Tests still locate it by kind (mafiaSeatIdx), never by a hardcoded index.
  const mafiaSeat = fx.roles.findIndex((r) => r === ROLE.MAFIA);
  const townSeat = fx.roles.findIndex((r) => r !== ROLE.MAFIA);
  return { ...ctx, fx, sched, teeSigner, matchId: 0, n, mafiaSeat, townSeat };
}

describe("MafiaMarket — 'Who is the Mafia?' side market (props): seeded at createMatch", () => {
  it("exists from creation: ONE categorical market with one outcome per seat, empty/Unset, at the documented index", async () => {
    const { market, n } = await opened("ms-create");
    expect(await market.propCount(0)).to.equal(4); // VO r1 + NK r1 + Faction + MafiaSeat
    const idx = await mafiaSeatIdx(market);
    expect(idx).to.equal(3); // documented creation layout: props[3]
    const pr = await market.getProp(0, idx);
    expect(pr.kind).to.equal(PROP_KIND.MafiaSeat);
    expect(pr.param).to.equal(0);              // param unused for this kind
    expect(pr.numOutcomes).to.equal(n);        // one outcome per seat
    expect(pr.pools.length).to.equal(n);
    for (const p of pr.pools) expect(p).to.equal(0);
    expect(pr.closed).to.equal(false);
    expect(pr.state).to.equal(PS.Unset);
    // exactly ONE MafiaSeat market per match — seeding replaced the old open-once guard
    let seatCount = 0;
    const count = Number(await market.propCount(0));
    for (let i = 0; i < count; i++) if (Number((await market.getProp(0, i)).kind) === PROP_KIND.MafiaSeat) seatCount++;
    expect(seatCount).to.equal(1);
  });

  it("createMatch announces it — MafiaSeatMarketOpened(matchId, 3) rides the create tx", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    await expect(
      market.createMatch(createParams({ roleCommit: "0x" + "aa".repeat(32), teeSigner: teeSigner.address, nonce: "ms-event", playerCount: 6, schedule: sched })),
    )
      .to.emit(market, "MafiaSeatMarketOpened").withArgs(0, 3);
  });
});

describe("MafiaMarket — 'Who is the Mafia?' side market (props): betting", () => {
  it("accumulates per-outcome pools independently of the round markets", async () => {
    const { market, alice, bob, mafiaSeat, townSeat } = await opened("ms-bet");
    const idx = await mafiaSeatIdx(market);
    await expect(market.connect(alice).betProp(0, idx, mafiaSeat, ethers.parseEther("1")))
      .to.emit(market, "PropBetPlaced");
    await market.connect(bob).betProp(0, idx, townSeat, ethers.parseEther("3"));

    const pr = await market.getProp(0, idx);
    expect(pr.pools[mafiaSeat]).to.equal(ethers.parseEther("1"));
    expect(pr.pools[townSeat]).to.equal(ethers.parseEther("3"));
    expect(await market.propStake(0, idx, mafiaSeat, alice.address)).to.equal(ethers.parseEther("1"));
    // the round-1 RoundVotedOut market (propIdx 0) is untouched
    expect((await market.getProp(0, 0)).pools[0]).to.equal(0);
  });

  it("refuses an out-of-range outcome (only seats 0..playerCount-1 exist)", async () => {
    const { market, alice, n } = await opened("ms-badout");
    const idx = await mafiaSeatIdx(market);
    await expect(market.connect(alice).betProp(0, idx, n, ethers.parseEther("1"))).to.be.revertedWith("bad outcome");
  });
});

describe("MafiaMarket — 'Who is the Mafia?' side market (props): settlement from verified roles", () => {
  it("resolves to the seat whose revealed role is MAFIA (even if that seat was killed)", async () => {
    const { market, alice, bob, fx, mafiaSeat, townSeat } = await opened("ms-resolve");
    expect(fx.roles[mafiaSeat]).to.equal(ROLE.MAFIA);
    const idx = await mafiaSeatIdx(market);
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
    const idx = await mafiaSeatIdx(market);
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
    const idx = await mafiaSeatIdx(market);
    await market.connect(alice).betProp(0, idx, townSeat, ethers.parseEther("2")); // only a town seat backed → Void
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.getProp(0, idx)).state).to.equal(PS.Void);

    const before = await token.balanceOf(alice.address);
    await expect(market.connect(alice).claimProp(0, idx)).to.emit(market, "PropClaimed");
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("2")); // full refund
  });
});
