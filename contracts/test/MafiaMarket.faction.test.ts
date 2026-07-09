import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, deployMarket, fundBettors, buildSettlement, factionIdx, FACTION_OUT, PROP_KIND } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

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
  // createMatch seeds props[0] RoundVotedOut r1, props[1] NightKill r1, props[2] Faction and
  // props[3] MafiaSeat — the headline "which faction wins?" market exists from block one, no
  // post-create open tx. Tests still locate it by kind (factionIdx), never by a hardcoded index.
  const mafiaSeat = fx.roles.findIndex((r) => r === 0);
  return { ...ctx, fx, sched, teeSigner, matchId: 0, n, mafiaSeat };
}

describe("MafiaMarket — 'which faction wins?' headline market (props): seeded at createMatch", () => {
  it("exists from creation: ONE binary market (TOWN / MAFIA), empty/Unset, at the documented index", async () => {
    const { market } = await opened("fac-create");
    expect(await market.propCount(0)).to.equal(4); // VO r1 + NK r1 + Faction + MafiaSeat
    const idx = await factionIdx(market);
    expect(idx).to.equal(2); // documented creation layout: props[2]
    const pr = await market.getProp(0, idx);
    expect(pr.kind).to.equal(PROP_KIND.Faction);
    expect(pr.param).to.equal(0);          // param unused for this kind
    expect(pr.numOutcomes).to.equal(2);    // binary: TOWN / MAFIA
    expect(pr.pools.length).to.equal(2);
    for (const p of pr.pools) expect(p).to.equal(0);
    expect(pr.closed).to.equal(false);
    expect(pr.state).to.equal(PS.Unset);
    // exactly ONE faction market per match — seeding replaced the old open-once guard
    let factionCount = 0;
    const count = Number(await market.propCount(0));
    for (let i = 0; i < count; i++) if (Number((await market.getProp(0, i)).kind) === PROP_KIND.Faction) factionCount++;
    expect(factionCount).to.equal(1);
  });

  it("createMatch announces it — FactionMarketOpened(matchId, 2) rides the create tx", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    await expect(
      market.createMatch(createParams({ roleCommit: "0x" + "aa".repeat(32), teeSigner: teeSigner.address, nonce: "fac-event", playerCount: 6, schedule: sched })),
    )
      .to.emit(market, "FactionMarketOpened").withArgs(0, 2);
  });

  it("is bettable the moment the window opens — no post-create host tx required", async () => {
    const { market, alice } = await opened("fac-bet");
    const idx = await factionIdx(market);
    await expect(market.connect(alice).betProp(0, idx, MAFIA, ethers.parseEther("1")))
      .to.emit(market, "PropBetPlaced");
    expect((await market.getProp(0, idx)).pools[MAFIA]).to.equal(ethers.parseEther("1"));
  });
});

describe("MafiaMarket — 'which faction wins?' headline market (props): settlement", () => {
  it("resolves to the engine-declared winning faction from the verified run", async () => {
    const { market, alice, bob, fx } = await opened("fac-resolve");
    const idx = await factionIdx(market);
    await market.connect(alice).betProp(0, idx, MAFIA, ethers.parseEther("1"));
    await market.connect(bob).betProp(0, idx, TOWN, ethers.parseEther("1"));
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    const pr = await market.getProp(0, idx);
    expect(pr.state).to.equal(PS.Resolved);
    expect(pr.winningOutcome).to.equal(fx.mafiaWins ? MAFIA : TOWN);
  });

  it("Voids on a mistrial (game unresolved) — full refund, no draw fee", async () => {
    const { market, token, alice, fx } = await opened("fac-mistrial");
    const idx = await factionIdx(market);
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
