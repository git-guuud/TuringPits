import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, deployMarket, fundBettors, buildSettlement } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

// PropState enum (MafiaMarket.sol): Unset=0, Resolved=1, Void=2.
const PS = { Unset: 0, Resolved: 1, Void: 2 } as const;

async function deploy() {
  const [owner, treasury, alice, bob, carol, stranger] = await ethers.getSigners();
  const { market, token } = await deployMarket(owner, treasury);
  await fundBettors(token, await market.getAddress(), [alice, bob, carol, stranger]);
  return { market, token, owner, treasury, alice, bob, carol, stranger };
}

/** A created match with betting open and a scripted settlement in hand (n=6 so a round-2 vote resolves). */
async function opened(nonce: string, n = 6) {
  const ctx = await deploy();
  const teeSigner = ethers.Wallet.createRandom();
  const fx = await buildSettlement(SEED, n, nonce, teeSigner);
  const sched = await defaultSchedule(ethers.provider);
  await ctx.market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: n, schedule: sched }));
  await mineUpTo(sched.bettingOpenBlock);
  const voIdx = (round: number) => (round === 1 ? 0 : round); // this suite only opens VotedOut rounds
  const noOne = n; // last outcome of a RoundVotedOut market = "no one"
  return { ...ctx, fx, sched, teeSigner, matchId: 0, n, voIdx, noOne };
}

describe("MafiaMarket — batch read views: getProps", () => {
  it("returns the whole prop array, field-for-field identical to per-index getProp", async () => {
    const { market, owner } = await opened("bv-getprops");
    await market.connect(owner).openVotedOutRound(0); // give the match a 3rd prop so length > the two defaults
    const count = Number(await market.propCount(0));
    const all = await market.getProps(0);
    expect(all.length).to.equal(count);
    for (let i = 0; i < count; i++) {
      const one = await market.getProp(0, i);
      expect(all[i].kind).to.equal(one.kind);
      expect(all[i].param).to.equal(one.param);
      expect(all[i].numOutcomes).to.equal(one.numOutcomes);
      expect(all[i].state).to.equal(one.state);
      expect(all[i].pools.length).to.equal(one.pools.length);
      for (let o = 0; o < one.pools.length; o++) expect(all[i].pools[o]).to.equal(one.pools[o]);
    }
  });

  it("returns an empty array for a match with no props", async () => {
    const { market } = await deploy();
    expect((await market.getProps(999)).length).to.equal(0);
  });
});

describe("MafiaMarket — batch read views: getUserMatch", () => {
  it("folds a wallet's per-outcome stakes and claimed flag into every market's state in one call", async () => {
    const { market, alice, bob, voIdx, noOne } = await opened("bv-usermatch");
    const idx = voIdx(1);
    // alice on the round-1 vote market (two outcomes); bob only touches the NightKill market.
    await market.connect(alice).betProp(0, idx, 2, ethers.parseEther("1.5"));
    await market.connect(alice).betProp(0, idx, noOne, ethers.parseEther("0.5"));
    await market.connect(bob).betProp(0, 1, 0, ethers.parseEther("4")); // NightKill r1

    const view = await market.getUserMatch(0, alice.address);
    expect(view.length).to.equal(Number(await market.propCount(0)));
    // Prop-level fields mirror getProp; stakes[] mirrors propStake for alice.
    const vo = view[idx];
    expect(vo.pools[2]).to.equal(ethers.parseEther("1.5"));
    expect(vo.stakes[2]).to.equal(ethers.parseEther("1.5"));
    expect(vo.stakes[noOne]).to.equal(ethers.parseEther("0.5"));
    expect(vo.stakes[0]).to.equal(0);
    expect(vo.claimed).to.equal(false);
    // alice never bet the NightKill market → all her stakes there are zero, but pool reflects bob's bet.
    expect(view[1].stakes.every((s: bigint) => s === 0n)).to.equal(true);
    expect(view[1].pools[0]).to.equal(ethers.parseEther("4"));
    // Every stakes[] length matches that market's numOutcomes.
    for (let i = 0; i < view.length; i++) expect(view[i].stakes.length).to.equal(Number(view[i].numOutcomes));
  });

  it("flips the claimed flag after the wallet collects", async () => {
    const { market, alice, bob, fx, voIdx, noOne } = await opened("bv-usermatch-claimed");
    const winSeat = fx.votedOutRound.findIndex((r: number) => r === 2);
    expect(winSeat, "a round-2 vote-out exists").to.be.greaterThanOrEqual(0);
    await market.openVotedOutRound(0);
    const idx = voIdx(2);
    await market.connect(alice).betProp(0, idx, winSeat, ethers.parseEther("1"));
    await market.connect(bob).betProp(0, idx, noOne, ethers.parseEther("1"));
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);

    expect((await market.getUserMatch(0, alice.address))[idx].claimed).to.equal(false);
    await market.connect(alice).claimProp(0, idx);
    expect((await market.getUserMatch(0, alice.address))[idx].claimed).to.equal(true);
  });
});

describe("MafiaMarket — batch read views: getUserMatchNets", () => {
  it("reports staked/returned that match the actual claim payouts (settled: winner pro-rata, loser 0)", async () => {
    const { market, token, alice, bob, carol, fx, voIdx, noOne } = await opened("bv-nets-settled");
    const winSeat = fx.votedOutRound.findIndex((r: number) => r === 2);
    await market.openVotedOutRound(0);
    const idx = voIdx(2);
    // winners: alice 1, carol 2; loser: bob 3 on "no one". net pot = 6 − 2% = 5.88, winning pool = 3.
    await market.connect(alice).betProp(0, idx, winSeat, ethers.parseEther("1"));
    await market.connect(carol).betProp(0, idx, winSeat, ethers.parseEther("2"));
    await market.connect(bob).betProp(0, idx, noOne, ethers.parseEther("3"));
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);

    const [aNet, bNet, cNet] = await market.getUserMatchNets(0, [alice.address, bob.address, carol.address]);
    // alice: staked 1, returns 5.88*1/3 = 1.96 (net +0.96)
    expect(aNet.staked).to.equal(ethers.parseEther("1"));
    expect(aNet.returned).to.equal(ethers.parseEther("1.96"));
    // carol: staked 2, returns 5.88*2/3 = 3.92 (net +1.92)
    expect(cNet.staked).to.equal(ethers.parseEther("2"));
    expect(cNet.returned).to.equal(ethers.parseEther("3.92"));
    // bob: staked 3, backed a loser → returns 0 (net −3)
    expect(bNet.staked).to.equal(ethers.parseEther("3"));
    expect(bNet.returned).to.equal(0);

    // `returned` equals what claimProp actually pays — the board figure IS the collectable amount.
    const a0 = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(0, idx);
    expect((await token.balanceOf(alice.address)) - a0).to.equal(aNet.returned);
  });

  it("sums a wallet's stake and return across MULTIPLE markets (a win in one, a real loss in another)", async () => {
    const { market, alice, bob, fx, voIdx, noOne } = await opened("bv-nets-multi");
    const winSeat1 = fx.votedOutRound.findIndex((r: number) => r === 1);
    const winSeat2 = fx.votedOutRound.findIndex((r: number) => r === 2);
    expect(winSeat1, "round-1 vote-out").to.be.greaterThanOrEqual(0);
    expect(winSeat2, "round-2 vote-out").to.be.greaterThanOrEqual(0);
    await market.openVotedOutRound(0);
    // alice backs the winner in round 1 (sole backer) and a loser in round 2.
    await market.connect(alice).betProp(0, voIdx(1), winSeat1, ethers.parseEther("2"));
    await market.connect(alice).betProp(0, voIdx(2), noOne, ethers.parseEther("1")); // "no one" — the loser
    // bob backs the ACTUAL round-2 winner so that market RESOLVES (not Void) → alice's stake there is a true loss.
    await market.connect(bob).betProp(0, voIdx(2), winSeat2, ethers.parseEther("1"));
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);

    const [net] = await market.getUserMatchNets(0, [alice.address]);
    expect(net.staked).to.equal(ethers.parseEther("3")); // 2 + 1 across two markets
    // round 1: sole winner → gets the whole net pot 2*0.98 = 1.96; round 2: backed the loser → 0.
    expect(net.returned).to.equal(ethers.parseEther("1.96"));
  });

  it("returns the full stake on an abandoned (RefundMode) match", async () => {
    const { market, alice, bob, sched, voIdx, noOne } = await opened("bv-nets-refund");
    await market.connect(alice).betProp(0, voIdx(1), 2, ethers.parseEther("2"));
    await market.connect(alice).betProp(0, voIdx(1), noOne, ethers.parseEther("1"));
    await market.connect(bob).betProp(0, 1, 0, ethers.parseEther("5")); // NightKill market
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(0);

    const [aNet, bNet] = await market.getUserMatchNets(0, [alice.address, bob.address]);
    // Every stake returns in full → staked == returned (net 0) for both.
    expect(aNet.staked).to.equal(ethers.parseEther("3"));
    expect(aNet.returned).to.equal(ethers.parseEther("3"));
    expect(bNet.staked).to.equal(ethers.parseEther("5"));
    expect(bNet.returned).to.equal(ethers.parseEther("5"));
  });

  it("reports zeros for a wallet that never wagered", async () => {
    const { market, alice, stranger, voIdx } = await opened("bv-nets-nobody");
    await market.connect(alice).betProp(0, voIdx(1), 2, ethers.parseEther("1"));
    const [net] = await market.getUserMatchNets(0, [stranger.address]);
    expect(net.staked).to.equal(0);
    expect(net.returned).to.equal(0);
  });
});

// The frontend (frontend/src/lib/abi.ts) calls these getters through hand-written human-readable ABI
// strings, so a field-order or type drift between those strings and the compiled contract would silently
// mis-decode. Re-declare a throwaway ethers.Contract with the EXACT frontend fragments and assert it
// decodes the same values the typed contract returns — a guard that abi.ts stays wire-compatible.
describe("MafiaMarket — batch read views: frontend ABI wire-compat", () => {
  const FRONTEND_ABI = [
    "function getProps(uint256 matchId) view returns (tuple(uint8 kind, uint8 param, uint8 numOutcomes, bool closed, uint8 state, uint8 winningOutcome, uint128 netPot, uint128 winningPool, uint128[] pools)[])",
    "function getUserMatch(uint256 matchId, address user) view returns (tuple(uint8 kind, uint8 param, uint8 numOutcomes, bool closed, uint8 state, uint8 winningOutcome, uint128 netPot, uint128 winningPool, uint128[] pools, uint128[] stakes, bool claimed)[])",
    "function getUserMatchNets(uint256 matchId, address[] users) view returns (tuple(uint128 staked, uint128 returned)[])",
  ] as const;

  it("decodes getProps / getUserMatch / getUserMatchNets via the frontend's ABI strings", async () => {
    const { market, alice, bob, carol, fx, voIdx, noOne } = await opened("bv-wire");
    const winSeat = fx.votedOutRound.findIndex((r: number) => r === 2);
    await market.openVotedOutRound(0);
    const idx = voIdx(2);
    await market.connect(alice).betProp(0, idx, winSeat, ethers.parseEther("1"));
    await market.connect(carol).betProp(0, idx, winSeat, ethers.parseEther("2"));
    await market.connect(bob).betProp(0, idx, noOne, ethers.parseEther("3"));
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);

    const fe = new ethers.Contract(await market.getAddress(), FRONTEND_ABI, ethers.provider);

    // getProps mirrors per-index getProp.
    const props = await fe.getProps(0);
    expect(props.length).to.equal(Number(await market.propCount(0)));
    expect(props[idx].winningOutcome).to.equal(winSeat);
    expect(props[idx].pools[winSeat]).to.equal(ethers.parseEther("3"));

    // getUserMatch decodes state + this wallet's stakes[] + claimed.
    const view = await fe.getUserMatch(0, alice.address);
    expect(view[idx].stakes[winSeat]).to.equal(ethers.parseEther("1"));
    expect(view[idx].claimed).to.equal(false);

    // getUserMatchNets decodes {staked, returned} — and matches the typed contract's numbers.
    const [aNet] = await fe.getUserMatchNets(0, [alice.address]);
    const [aTyped] = await market.getUserMatchNets(0, [alice.address]);
    expect(aNet.staked).to.equal(aTyped.staked).and.to.equal(ethers.parseEther("1"));
    expect(aNet.returned).to.equal(aTyped.returned).and.to.equal(ethers.parseEther("1.96"));
  });
});
