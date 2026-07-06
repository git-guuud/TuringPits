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
  // createMatch lays out props[0] RoundVotedOut r1, props[1] NightKill r1 (the per-seat PlayerFate market
  // is not floated for now). This suite only ever opens NightKill rounds (never VotedOut), so its markets
  // append sequentially right after NK r1: round 1 at 1, then each later round at `round` (the first
  // openNightKillRound lands at the propCount==2 tail). Outcomes: seat 0..n-1, then "no one" == n.
  const nkIdx = (round: number) => (round === 1 ? 1 : round);
  const noOne = n; // the last outcome index (playerCount): kill blocked / a quiet night
  return { ...ctx, fx, sched, teeSigner, matchId: 0, n, nkIdx, noOne };
}

describe("MafiaMarket — per-round 'night kill' side markets (props): creation", () => {
  it("creates the round-1 NightKill market after the RoundVotedOut market (index == 1, param == 1, n+1 outcomes)", async () => {
    const { market, n, nkIdx, noOne } = await opened("nk-create");
    expect(await market.propCount(0)).to.equal(2); // VO r1 + NK r1 (no PlayerFate market)
    expect(await market.nightKillRoundsOpened(0)).to.equal(1); // round 1 open up front
    // NK r1 sits right after the round-1 RoundVotedOut market.
    expect((await market.getProp(0, 0)).kind).to.equal(KIND.RoundVotedOut);
    const pr = await market.getProp(0, nkIdx(1));
    expect(pr.kind).to.equal(KIND.NightKill);
    expect(pr.param).to.equal(1);
    expect(pr.numOutcomes).to.equal(noOne + 1); // n seats + "no one"
    expect(pr.pools.length).to.equal(noOne + 1);
    for (const p of pr.pools) expect(p).to.equal(0);
    expect(pr.closed).to.equal(false);
    expect(pr.state).to.equal(PS.Unset);
  });

  it("PropsCreated counts exactly the two round-1 markets (RoundVotedOut + NightKill == 2), independent of playerCount", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    const commit = "0x" + "aa".repeat(32);
    // Any seat count → 1 RoundVotedOut + 1 NightKill = 2 side markets at creation (no per-seat fate market).
    await expect(market.createMatch(createParams({ roleCommit: commit, teeSigner: teeSigner.address, nonce: "nk-7", playerCount: 7, schedule: sched })))
      .to.emit(market, "PropsCreated").withArgs(0, 2);
    expect(await market.propCount(0)).to.equal(2);
    const nk = await market.getProp(0, 1); // second market == round-1 NightKill
    expect(nk.kind).to.equal(KIND.NightKill);
    expect(nk.param).to.equal(1);
    expect(nk.numOutcomes).to.equal(8);
  });
});

describe("MafiaMarket — per-round 'night kill' side markets (props): opening later rounds", () => {
  it("openNightKillRound appends the next round's market and bumps the counter", async () => {
    const { market, owner, n, nkIdx } = await opened("nk-open");
    // Round 2: appended at the tail (propIdx 2), tagged param 2.
    await expect(market.connect(owner).openNightKillRound(0)).to.emit(market, "NightKillRoundOpened").withArgs(0, 2, nkIdx(2));
    expect(await market.nightKillRoundsOpened(0)).to.equal(2);
    expect(await market.propCount(0)).to.equal(3);
    const r2 = await market.getProp(0, nkIdx(2));
    expect(r2.kind).to.equal(KIND.NightKill);
    expect(r2.param).to.equal(2);
    expect(r2.numOutcomes).to.equal(n + 1);
    // Round 3: sequential — appended at the next tail, param 3.
    await expect(market.connect(owner).openNightKillRound(0)).to.emit(market, "NightKillRoundOpened").withArgs(0, 3, nkIdx(3));
    expect(await market.nightKillRoundsOpened(0)).to.equal(3);
    expect((await market.getProp(0, nkIdx(3))).param).to.equal(3);
  });

  it("is owner-only and refuses to open once the match is no longer accepting bets", async () => {
    const { market, stranger, fx } = await opened("nk-open-auth");
    await expect(market.connect(stranger).openNightKillRound(0)).to.be.revertedWith("not owner");
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    await expect(market.openNightKillRound(0)).to.be.revertedWith("not open");
  });

  it("interleaves cleanly with openVotedOutRound — both recurring kinds keep their own counter/tail", async () => {
    const { market, owner, n } = await opened("nk-interleave");
    // Open round 2 for BOTH kinds in either order; the tail grows and the two kinds interleave, so an
    // index formula would break — the layout is discoverable only by reading each prop's (kind, param).
    await market.connect(owner).openVotedOutRound(0); // VO r2 at idx 2
    await market.connect(owner).openNightKillRound(0); // NK r2 at idx 3
    expect(await market.votedOutRoundsOpened(0)).to.equal(2);
    expect(await market.nightKillRoundsOpened(0)).to.equal(2);
    expect(await market.propCount(0)).to.equal(4);
    // Find each round-2 market by scanning — the robust addressing the server/UI use.
    const count = Number(await market.propCount(0));
    let voR2 = -1, nkR2 = -1;
    for (let i = 0; i < count; i++) {
      const pr = await market.getProp(0, i);
      if (Number(pr.kind) === KIND.RoundVotedOut && Number(pr.param) === 2) voR2 = i;
      if (Number(pr.kind) === KIND.NightKill && Number(pr.param) === 2) nkR2 = i;
    }
    expect(voR2).to.equal(2);
    expect(nkR2).to.equal(3);
  });
});

describe("MafiaMarket — per-round 'night kill' side markets (props): betting", () => {
  it("accumulates per-outcome pools on a round-2 market independently of round 1", async () => {
    const { market, owner, alice, bob, nkIdx, noOne } = await opened("nk-bet");
    await market.connect(owner).openNightKillRound(0); // round 2 now bettable
    const idx = nkIdx(2);
    await expect(market.connect(alice).betProp(0, idx, 3, ethers.parseEther("1"))) // seat-3 outcome
      .to.emit(market, "PropBetPlaced");
    await market.connect(bob).betProp(0, idx, noOne, ethers.parseEther("3")); // "no one" outcome

    const pr = await market.getProp(0, idx);
    expect(pr.pools[3]).to.equal(ethers.parseEther("1"));
    expect(pr.pools[noOne]).to.equal(ethers.parseEther("3"));
    expect(await market.propStake(0, idx, 3, alice.address)).to.equal(ethers.parseEther("1"));
    // the round-1 NightKill market is untouched
    expect((await market.getProp(0, nkIdx(1))).pools[3]).to.equal(0);
  });
});

describe("MafiaMarket — per-round 'night kill' side markets (props): per-round settlement", () => {
  // n=6: the scripted strategy lands a night kill in round 1 AND round 2 (the match runs long enough
  // for a round-2 day vote, so night 2 resolved first), so both markets resolve to a real seat winner.
  it("resolves EACH round's market against THAT round's NIGHT kill (== engine truth)", async () => {
    const { market, alice, bob, fx, nkIdx, noOne } = await opened("nk-settle", 6);
    expect(fx.nightKillRound.some((r) => r === 1), "round-1 night kill exists").to.equal(true);
    expect(fx.nightKillRound.some((r) => r >= 2), "round-2 night kill exists").to.equal(true);
    await market.openNightKillRound(0); // float the round-2 market

    // For each round, fund the seat the night kill actually took (winner) + "no one" (loser), so each
    // market resolves to a real seat winner — a clean cross-check of the night-kill resolver per round.
    for (const round of [1, 2]) {
      const winSeat = fx.nightKillRound.findIndex((r) => r === round);
      await market.connect(alice).betProp(0, nkIdx(round), winSeat, ethers.parseEther("1"));
      await market.connect(bob).betProp(0, nkIdx(round), noOne, ethers.parseEther("1"));
    }
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    for (const round of [1, 2]) {
      const winSeat = fx.nightKillRound.findIndex((r) => r === round);
      const pr = await market.getProp(0, nkIdx(round));
      expect(pr.state, `round ${round}`).to.equal(PS.Resolved);
      expect(pr.winningOutcome, `round ${round}`).to.equal(winSeat);
      expect(pr.winningPool).to.equal(ethers.parseEther("1"));
      expect(pr.netPot).to.equal(ethers.parseEther("1.96")); // gross 2, fee 2% = 0.04
    }
  });

  it("never resolves a NightKill market to a day-VOTE casualty (a vote-out is not a night kill)", async () => {
    const { market, alice, bob, fx, nkIdx, noOne } = await opened("nk-not-vote", 6);
    // A seat eliminated by the round-1 DAY VOTE must NOT win the round-1 NightKill market.
    const votedSeat = fx.votedOutRound.findIndex((r) => r === 1);
    expect(votedSeat, "a round-1 vote-out exists").to.be.greaterThanOrEqual(0);
    const nightSeat = fx.nightKillRound.findIndex((r) => r === 1);
    expect(nightSeat, "a round-1 night kill exists").to.be.greaterThanOrEqual(0);
    expect(votedSeat).to.not.equal(nightSeat); // the two round-1 casualties are different seats

    await market.connect(alice).betProp(0, nkIdx(1), votedSeat, ethers.parseEther("1")); // the vote-out seat (loses)
    await market.connect(bob).betProp(0, nkIdx(1), nightSeat, ethers.parseEther("1")); // the night-kill seat (wins)
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    const pr = await market.getProp(0, nkIdx(1));
    expect(pr.winningOutcome).to.equal(nightSeat);
  });

  it("resolves a round with NO night kill (a quiet night / past the match) to the 'no one' outcome", async () => {
    const { market, owner, token, alice, fx, nkIdx, noOne } = await opened("nk-noone", 6);
    // A round beyond the match's last night kill has no casualty → the "no one" outcome wins.
    const maxNkRound = Math.max(0, ...fx.nightKillRound);
    const noOneRound = maxNkRound + 1;
    for (let r = 2; r <= noOneRound; r++) await market.connect(owner).openNightKillRound(0);
    expect(fx.nightKillRound.every((r) => r !== noOneRound), "no seat is night-killed in noOneRound").to.equal(true);

    const idx = nkIdx(noOneRound);
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

  it("pays the backers of a round-2 night kill pro-rata via claimProp; blocks double / loser claim", async () => {
    const { market, token, alice, bob, carol, fx, nkIdx, noOne } = await opened("nk-claim", 6);
    const winSeat = fx.nightKillRound.findIndex((r) => r === 2); // the seat the round-2 night kill took
    expect(winSeat, "a round-2 night kill exists").to.be.greaterThanOrEqual(0);
    await market.openNightKillRound(0);
    const idx = nkIdx(2);
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
    const { market, token, alice, fx, nkIdx, noOne } = await opened("nk-void", 6);
    await market.openNightKillRound(0);
    const idx = nkIdx(2);
    // Only losing outcomes funded ("no one" + a seat that isn't the round-2 casualty) → winning pool empty → Void.
    await market.connect(alice).betProp(0, idx, noOne, ethers.parseEther("2"));
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.getProp(0, idx)).state).to.equal(PS.Void);

    const before = await token.balanceOf(alice.address);
    await expect(market.connect(alice).claimProp(0, idx)).to.emit(market, "PropClaimed");
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("2")); // full refund
  });
});

describe("MafiaMarket — per-round 'night kill' side markets (props): mid-match close (dawn freeze)", () => {
  it("freezes a round's market once the host closes it at dawn, yet still resolves from the verified run", async () => {
    const { market, token, owner, alice, bob, fx, nkIdx, noOne } = await opened("nk-close", 6);
    const winSeat = fx.nightKillRound.findIndex((r) => r === 1);
    const idx = nkIdx(1); // round-1 NightKill (created up front)
    await market.connect(alice).betProp(0, idx, winSeat, ethers.parseEther("1"));
    await market.connect(bob).betProp(0, idx, noOne, ethers.parseEther("1"));
    // Dawn: the host freezes the night market once the night's kill is public.
    await expect(market.connect(owner).closeProp(0, idx)).to.emit(market, "PropClosed").withArgs(0, idx);
    await expect(market.connect(alice).betProp(0, idx, winSeat, ethers.parseEther("1"))).to.be.revertedWith("prop closed");

    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    const pr = await market.getProp(0, idx);
    expect(pr.closed).to.equal(true);
    expect(pr.winningOutcome).to.equal(winSeat); // resolves despite the freeze
    const before = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(0, idx);
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("1.96"));
  });
});
