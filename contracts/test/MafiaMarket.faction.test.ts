import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, deployMarket, fundBettors, buildSettlement, FACTION_OUT } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

// PropKind enum (MafiaMarket.sol): PlayerFate=0, RoundVotedOut=1, NightKill=2, DetectiveClaim=3, MafiaSeat=4, Faction=5.
const KIND = { PlayerFate: 0, RoundVotedOut: 1, NightKill: 2, DetectiveClaim: 3, MafiaSeat: 4, Faction: 5 } as const;
// PropState enum: Unset=0, Resolved=1, Void=2.
const PS = { Unset: 0, Resolved: 1, Void: 2 } as const;
// Faction outcomes: 0 = TOWN wins, 1 = MAFIA wins.
const { TOWN, MAFIA } = FACTION_OUT;

async function deploy() {
  const [owner, treasury, alice, bob, stranger] = await ethers.getSigners();
  const { market, token } = await deployMarket(owner, treasury);
  await fundBettors(token, await market.getAddress(), [alice, bob, stranger]);
  return { market, token, owner, treasury, alice, bob, stranger };
}

/** A created match whose betting window is open, with a real scripted settlement in hand. */
async function opened(nonce: string, n = 6) {
  const ctx = await deploy();
  const teeSigner = ethers.Wallet.createRandom();
  const fx = await buildSettlement(SEED, n, nonce, teeSigner);
  const sched = await defaultSchedule(ethers.provider);
  await ctx.market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: n, schedule: sched }));
  await mineUpTo(sched.bettingOpenBlock);
  // createMatch mints props[0..n-1] PlayerFate, props[n] RoundVotedOut r1, props[n+1] NightKill r1. The
  // headline "which faction wins?" market is NOT created up front — the host floats it once at match start
  // via openFactionMarket() and it appends at the tail, so with nothing else opened it lands at propIdx n+2.
  const mafiaSeat = fx.roles.findIndex((r) => r === 0);
  return { ...ctx, fx, sched, teeSigner, matchId: 0, n, mafiaSeat };
}

describe("MafiaMarket — 'which faction wins?' headline market (props): creation on demand", () => {
  it("is NOT created up front — createMatch still mints exactly playerCount + 2 props, flag unset", async () => {
    const { market, n } = await opened("fac-create");
    expect(await market.propCount(0)).to.equal(n + 2); // n PlayerFate + VO r1 + NK r1, no Faction yet
    expect(await market.factionMarketOpened(0)).to.equal(false);
    const count = Number(await market.propCount(0));
    for (let i = 0; i < count; i++) expect(Number((await market.getProp(0, i)).kind)).to.not.equal(KIND.Faction);
  });

  it("openFactionMarket appends ONE binary market (TOWN / MAFIA) and flips the guard", async () => {
    const { market, owner, n } = await opened("fac-open");
    const idx = Number(await market.propCount(0)); // tail == n+2
    await expect(market.connect(owner).openFactionMarket(0))
      .to.emit(market, "FactionMarketOpened").withArgs(0, idx);
    expect(await market.factionMarketOpened(0)).to.equal(true);
    expect(await market.propCount(0)).to.equal(n + 3);
    const pr = await market.getProp(0, idx);
    expect(pr.kind).to.equal(KIND.Faction);
    expect(pr.param).to.equal(0);          // param unused for this kind
    expect(pr.numOutcomes).to.equal(2);    // binary: TOWN / MAFIA
    expect(pr.pools.length).to.equal(2);
    for (const p of pr.pools) expect(p).to.equal(0);
    expect(pr.closed).to.equal(false);
    expect(pr.state).to.equal(PS.Unset);
  });

  it("opens at most ONCE — a second call reverts instead of minting a second market", async () => {
    const { market, owner } = await opened("fac-once");
    await market.connect(owner).openFactionMarket(0);
    await expect(market.connect(owner).openFactionMarket(0)).to.be.revertedWith("already opened");
  });

  it("is owner-only and refuses to open once the match is no longer accepting bets", async () => {
    const { market, stranger, fx } = await opened("fac-auth");
    await expect(market.connect(stranger).openFactionMarket(0)).to.be.revertedWith("not owner");
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    await expect(market.openFactionMarket(0)).to.be.revertedWith("not open");
  });
});

describe("MafiaMarket — 'which faction wins?' headline market (props): settlement", () => {
  it("resolves to the engine-declared winning faction from the verified run", async () => {
    const { market, owner, alice, bob, fx } = await opened("fac-resolve");
    const idx = Number(await market.propCount(0));
    await market.connect(owner).openFactionMarket(0);
    await market.connect(alice).betProp(0, idx, MAFIA, ethers.parseEther("1"));
    await market.connect(bob).betProp(0, idx, TOWN, ethers.parseEther("1"));
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    const pr = await market.getProp(0, idx);
    expect(pr.state).to.equal(PS.Resolved);
    expect(pr.winningOutcome).to.equal(fx.mafiaWins ? MAFIA : TOWN);
  });

  it("Voids on a mistrial (game unresolved) — full refund, no draw fee", async () => {
    const { market, token, owner, alice, fx } = await opened("fac-mistrial");
    const idx = Number(await market.propCount(0));
    await market.connect(owner).openFactionMarket(0);
    await market.connect(alice).betProp(0, idx, MAFIA, ethers.parseEther("2"));
    // A strict legal prefix leaves the game unresolved → mistrial → Void.
    await market.settle(0, fx.moves.slice(0, fx.moves.length - 1), fx.roles, fx.salt, CID);
    expect((await market.getProp(0, idx)).state).to.equal(PS.Void);
    expect(await market.protocolFeeAccrued()).to.equal(0); // Void is fee-free

    const before = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(0, idx);
    expect((await token.balanceOf(alice.address)) - before).to.equal(ethers.parseEther("2")); // full refund
  });
});
