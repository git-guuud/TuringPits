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

/** A created match whose betting window is open, with a real scripted settlement in hand. */
async function opened(nonce: string, n = 5) {
  const ctx = await deploy();
  const teeSigner = ethers.Wallet.createRandom();
  const fx = await buildSettlement(SEED, n, nonce, teeSigner);
  const sched = await defaultSchedule(ethers.provider);
  await ctx.market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: n, schedule: sched }));
  await mineUpTo(sched.bettingOpenBlock);
  // createMatch lays out props[0..n-1] PlayerFate, props[n] RoundVotedOut r1, props[n+1] NightKill r1.
  // This suite only ever opens VotedOut rounds (never NightKill), so its later rounds append past NK r1:
  // round 1 stays at n, and round R>=2 lands at n+R (the first openVotedOutRound lands at the n+2 tail).
  // Outcomes: seat 0..n-1, then "no one" == n.
  const voIdx = (round: number) => (round === 1 ? n : n + round);
  const noOne = n; // the last outcome index (playerCount): tie / no elimination
  return { ...ctx, fx, sched, teeSigner, matchId: 0, n, voIdx, noOne };
}

describe("MafiaMarket — per-round 'voted out' side markets (props): creation", () => {
  it("creates the round-1 RoundVotedOut market after the PlayerFate block (index == n, param == 1, n+1 outcomes)", async () => {
    const { market, n, voIdx, noOne } = await opened("vo-create");
    expect(await market.propCount(0)).to.equal(n + 2); // n PlayerFate + VO r1 + NK r1
    expect(await market.votedOutRoundsOpened(0)).to.equal(1); // round 1 is open up front
    const pr = await market.getProp(0, voIdx(1));
    expect(pr.kind).to.equal(KIND.RoundVotedOut);
    expect(pr.param).to.equal(1);
    expect(pr.numOutcomes).to.equal(noOne + 1); // n seats + "no one"
    expect(pr.pools.length).to.equal(noOne + 1);
    for (const p of pr.pools) expect(p).to.equal(0);
    expect(pr.closed).to.equal(false);
    expect(pr.state).to.equal(PS.Unset);
  });
});

describe("MafiaMarket — per-round 'voted out' side markets (props): opening later rounds", () => {
  it("openVotedOutRound appends the next round's market contiguously and bumps the counter", async () => {
    const { market, owner, n, voIdx } = await opened("vo-open");
    // Round 2: appended at the tail (propIdx n+2, past the round-1 NightKill market), tagged param 2.
    await expect(market.connect(owner).openVotedOutRound(0)).to.emit(market, "VotedOutRoundOpened").withArgs(0, 2, voIdx(2));
    expect(await market.votedOutRoundsOpened(0)).to.equal(2);
    expect(await market.propCount(0)).to.equal(n + 3);
    const r2 = await market.getProp(0, voIdx(2));
    expect(r2.kind).to.equal(KIND.RoundVotedOut);
    expect(r2.param).to.equal(2);
    expect(r2.numOutcomes).to.equal(n + 1);
    // Round 3: the next call is sequential — appended at n+3, param 3.
    await expect(market.connect(owner).openVotedOutRound(0)).to.emit(market, "VotedOutRoundOpened").withArgs(0, 3, voIdx(3));
    expect(await market.votedOutRoundsOpened(0)).to.equal(3);
    expect(await market.propCount(0)).to.equal(n + 4);
    expect((await market.getProp(0, voIdx(3))).param).to.equal(3);
  });

  it("is owner-only and refuses to open once the match is no longer accepting bets", async () => {
    const { market, stranger, fx } = await opened("vo-open-auth");
    await expect(market.connect(stranger).openVotedOutRound(0)).to.be.revertedWith("not owner");
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    await expect(market.openVotedOutRound(0)).to.be.revertedWith("not open");
  });
});

describe("MafiaMarket — per-round 'voted out' side markets (props): betting", () => {
  it("accumulates per-outcome pools on a round-2 market independently of round 1 and the seats' fate markets", async () => {
    const { market, owner, alice, bob, voIdx, noOne } = await opened("vo-bet");
    await market.connect(owner).openVotedOutRound(0); // round 2 now bettable
    const idx = voIdx(2);
    await expect(market.connect(alice).betProp(0, idx, 2, ethers.parseEther("1"))) // seat-2 outcome
      .to.emit(market, "PropBetPlaced");
    await market.connect(bob).betProp(0, idx, noOne, ethers.parseEther("3")); // "no one" outcome

    const pr = await market.getProp(0, idx);
    expect(pr.pools[2]).to.equal(ethers.parseEther("1"));
    expect(pr.pools[noOne]).to.equal(ethers.parseEther("3"));
    expect(await market.propStake(0, idx, 2, alice.address)).to.equal(ethers.parseEther("1"));
    // round-1 RoundVotedOut market and seat 2's PlayerFate market are untouched
    expect((await market.getProp(0, voIdx(1))).pools[2]).to.equal(0);
    expect((await market.getProp(0, 2)).pools[0]).to.equal(0);
  });
});

describe("MafiaMarket — per-round 'voted out' side markets (props): per-round settlement", () => {
  // n=6: the scripted strategy convicts seat 0 in round 1 AND seat 1 in round 2 before the match
  // ends (n=5 only ever has a single day vote), so both markets resolve a real seat winner.
  it("resolves EACH round's market against THAT round's day vote (== engine truth)", async () => {
    const { market, alice, bob, fx, voIdx, noOne } = await opened("vo-settle", 6);
    expect(fx.votedOutRound.some((r) => r === 1), "round-1 vote-out exists").to.equal(true);
    expect(fx.votedOutRound.some((r) => r >= 2), "round-2 vote-out exists").to.equal(true);
    await market.openVotedOutRound(0); // float the round-2 market

    // For each round, fund the seat the vote actually took (winner) + the "no one" outcome (loser),
    // so each market resolves to a real seat winner — a clean cross-check of g.votedOutRound per round.
    for (const round of [1, 2]) {
      const winSeat = fx.votedOutRound.findIndex((r) => r === round);
      await market.connect(alice).betProp(0, voIdx(round), winSeat, ethers.parseEther("1"));
      await market.connect(bob).betProp(0, voIdx(round), noOne, ethers.parseEther("1"));
    }
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    for (const round of [1, 2]) {
      const winSeat = fx.votedOutRound.findIndex((r) => r === round);
      const pr = await market.getProp(0, voIdx(round));
      expect(pr.state, `round ${round}`).to.equal(PS.Resolved);
      expect(pr.winningOutcome, `round ${round}`).to.equal(winSeat);
      expect(pr.winningPool).to.equal(ethers.parseEther("1"));
      expect(pr.netPot).to.equal(ethers.parseEther("1.96")); // gross 2, fee 2% = 0.04
    }
  });

  it("resolves a round with NO elimination to the 'no one' outcome (== numOutcomes - 1)", async () => {
    const { market, owner, token, alice, fx, voIdx, noOne } = await opened("vo-noone", 6);
    // A round beyond the match's last day-vote has no elimination → the "no one" outcome wins.
    const maxVoRound = Math.max(0, ...fx.votedOutRound);
    const noOneRound = maxVoRound + 1;
    for (let r = 2; r <= noOneRound; r++) await market.connect(owner).openVotedOutRound(0);
    expect(fx.votedOutRound.every((r) => r !== noOneRound), "no seat is voted out in noOneRound").to.equal(true);

    const idx = voIdx(noOneRound);
    await market.connect(alice).betProp(0, idx, noOne, ethers.parseEther("1")); // winner ("no one")
    await market.connect(alice).betProp(0, idx, 0, ethers.parseEther("1")); // a seat outcome (loser)
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    const pr = await market.getProp(0, idx);
    expect(pr.state).to.equal(PS.Resolved);
    expect(pr.winningOutcome).to.equal(noOne);
    expect(pr.winningPool).to.equal(ethers.parseEther("1"));
    // gross 2, fee 2% = 0.04, netPot 1.96 → the "no one" backer collects 1.96
    const before = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(0, idx);
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("1.96"));
  });

  it("pays the backers of a round-2 vote-out pro-rata via claimProp; blocks double / loser claim", async () => {
    const { market, token, alice, bob, carol, fx, voIdx, noOne } = await opened("vo-claim", 6);
    const winSeat = fx.votedOutRound.findIndex((r) => r === 2); // the seat the round-2 vote takes
    expect(winSeat, "a round-2 vote-out exists").to.be.greaterThanOrEqual(0);
    await market.openVotedOutRound(0);
    const idx = voIdx(2);
    await market.connect(alice).betProp(0, idx, winSeat, ethers.parseEther("1"));
    await market.connect(carol).betProp(0, idx, winSeat, ethers.parseEther("2"));
    await market.connect(bob).betProp(0, idx, noOne, ethers.parseEther("3")); // loser ("no one")
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.getProp(0, idx)).winningOutcome).to.equal(winSeat);

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

  it("Voids a round-2 market when nobody backed the winning outcome, and refunds via claimProp", async () => {
    const { market, token, alice, fx, voIdx, noOne } = await opened("vo-void", 6);
    const winSeat = fx.votedOutRound.findIndex((r) => r === 2);
    await market.openVotedOutRound(0);
    const idx = voIdx(2);
    // Only losing outcomes funded ("no one" + a seat that isn't the round-2 casualty) → winning pool empty → Void.
    await market.connect(alice).betProp(0, idx, noOne, ethers.parseEther("2"));
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.getProp(0, idx)).state).to.equal(PS.Void);

    const before = await token.balanceOf(alice.address);
    await expect(market.connect(alice).claimProp(0, idx)).to.emit(market, "PropClaimed");
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("2")); // full refund
  });
});

describe("MafiaMarket — per-round 'voted out' side markets (props): mid-match close", () => {
  it("freezes a round-2 market's betting once the host closes it, yet still resolves from the verified run", async () => {
    const { market, token, owner, alice, bob, fx, voIdx, noOne } = await opened("vo-close", 6);
    const winSeat = fx.votedOutRound.findIndex((r) => r === 2);
    await market.connect(owner).openVotedOutRound(0);
    const idx = voIdx(2);
    await market.connect(alice).betProp(0, idx, winSeat, ethers.parseEther("1"));
    await market.connect(bob).betProp(0, idx, noOne, ethers.parseEther("1"));
    await expect(market.connect(owner).closeProp(0, idx)).to.emit(market, "PropClosed").withArgs(0, idx);
    await expect(market.connect(alice).betProp(0, idx, winSeat, ethers.parseEther("1"))).to.be.revertedWith("prop closed");

    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    const pr = await market.getProp(0, idx);
    expect(pr.closed).to.equal(true);
    expect(pr.winningOutcome).to.equal(winSeat); // resolves despite the freeze
    // gross 2, fee 2% = 0.04, netPot 1.96, winning pool = 1 → alice claims 1.96
    const before = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(0, idx);
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("1.96"));
  });
});
