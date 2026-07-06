import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, deployMarket, fundBettors, openFaction, FACTION_OUT } from "./helpers/market";
import { buildSettlement } from "./helpers/market";
import { buildEnvelope } from "./helpers/envelope";

const DUMMY_COMMIT = "0x" + "aa".repeat(32);
const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

// PropState enum (MafiaMarket.sol): Unset=0, Resolved=1, Void=2.
const PS = { Unset: 0, Resolved: 1, Void: 2 } as const;
// The headline "which faction wins?" market is now a normal 2-outcome Prop (PropKind.Faction). Wagering,
// claiming and refunding all flow through the SAME categorical path (betProp/claimProp/refundProp) as every
// other market — there is no bespoke betYes/betNo/claim/refund/Outcome anymore.
const MAFIA = FACTION_OUT.MAFIA; // outcome 1 — Mafia walks (old YES)
const TOWN = FACTION_OUT.TOWN;   // outcome 0 — Town prevails (old NO)

async function deploy() {
  const [owner, treasury, alice, bob, carol, stranger] = await ethers.getSigners();
  const { market, token } = await deployMarket(owner, treasury);
  // Mint + approve CHIP for every signer the tests bet from.
  await fundBettors(token, await market.getAddress(), [alice, bob, carol, stranger]);
  return { market, token, owner, treasury, alice, bob, carol, stranger };
}

describe("MafiaMarket factory — createMatch", () => {
  it("constructor reverts on zero treasury / zero token", async () => {
    const [owner] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockBetToken");
    const token = await Token.connect(owner).deploy(ethers.ZeroAddress); // no forwarder needed for this check
    const Market = await ethers.getContractFactory("MafiaMarket");
    const fwd = ethers.ZeroAddress;
    await expect(Market.connect(owner).deploy(ethers.ZeroAddress, await token.getAddress(), fwd)).to.be.revertedWith("zero treasury");
    await expect(Market.connect(owner).deploy(owner.address, ethers.ZeroAddress, fwd)).to.be.revertedWith("zero token");
  });

  it("creates a match, stores fields, emits MatchCreated, increments id", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    const p = createParams({ roleCommit: DUMMY_COMMIT, teeSigner: teeSigner.address, nonce: "m-1", playerCount: 5, schedule: sched });

    await expect(market.createMatch(p)).to.emit(market, "MatchCreated");
    expect(await market.nextMatchId()).to.equal(1);

    const m = await market.matches(0);
    expect(m.state).to.equal(1); // Created
    expect(m.roleCommit).to.equal(DUMMY_COMMIT);
    expect(m.teeSigner).to.equal(teeSigner.address);
    expect(m.bettingCloseBlock).to.equal(sched.bettingCloseBlock);
    expect(m.feeBps).to.equal(200);
    expect(m.entropySeed).to.not.equal(ethers.ZeroHash);
  });

  it("only owner can create", async () => {
    const { market, alice } = await deploy();
    const sched = await defaultSchedule(ethers.provider);
    const p = createParams({ roleCommit: DUMMY_COMMIT, teeSigner: alice.address, nonce: "m", playerCount: 5, schedule: sched });
    await expect(market.connect(alice).createMatch(p)).to.be.revertedWith("not owner");
  });

  it("validates schedule and fees", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const base = await defaultSchedule(ethers.provider);
    const mk = (over: any, extra: any = {}) =>
      createParams({ roleCommit: DUMMY_COMMIT, teeSigner: teeSigner.address, nonce: "m", playerCount: 5, schedule: { ...base, ...over }, ...extra });

    await expect(market.createMatch(mk({ bettingOpenBlock: 0 }))).to.be.revertedWith("open in past");
    await expect(market.createMatch(mk({ bettingCloseBlock: base.bettingOpenBlock + 50 }))).to.be.revertedWith("window too short");
    await expect(market.createMatch(mk({ matchStartBlock: base.bettingCloseBlock + 1 }))).to.be.revertedWith("no lock buffer");
    await expect(market.createMatch(mk({ settlementDeadlineBlock: base.matchStartBlock + 10 }))).to.be.revertedWith("deadline too soon");
    await expect(market.createMatch(mk({}, { feeBps: 600 }))).to.be.revertedWith("fee too high");
  });

  it("rejects zero signer and bad player count", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    await expect(market.createMatch(createParams({ roleCommit: DUMMY_COMMIT, teeSigner: ethers.ZeroAddress, nonce: "m", playerCount: 5, schedule: sched }))).to.be.revertedWith("zero signer");
    await expect(market.createMatch(createParams({ roleCommit: DUMMY_COMMIT, teeSigner: teeSigner.address, nonce: "m", playerCount: 4, schedule: sched }))).to.be.revertedWith("bad player count");
  });
});

describe("MafiaMarket factory — faction market betting + lock", () => {
  async function opened() {
    const { market, token, owner, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    const p = createParams({ roleCommit: DUMMY_COMMIT, teeSigner: teeSigner.address, nonce: "m-1", playerCount: 5, schedule: sched });
    await market.createMatch(p);
    const faction = await openFaction(market, owner); // the headline market, floated at match start
    return { market, token, owner, alice, bob, sched, matchId: 0, faction };
  }

  it("reverts a bet before open, stays open past the close block, reverts past the deadline", async () => {
    const { market, alice, sched, matchId, faction } = await opened();
    await expect(market.connect(alice).betProp(matchId, faction, MAFIA, ethers.parseEther("1"))).to.be.revertedWith("betting not started");
    await mineUpTo(sched.bettingOpenBlock);
    // Market stays OPEN until settled — a bet well past the old close block still succeeds.
    await mineUpTo(sched.bettingCloseBlock + 10);
    await market.connect(alice).betProp(matchId, faction, MAFIA, ethers.parseEther("1"));
    expect((await market.getProp(matchId, faction)).pools[MAFIA]).to.equal(ethers.parseEther("1"));
    // Past the settlement deadline the match is refund-eligible, so new stakes are refused.
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await expect(market.connect(alice).betProp(matchId, faction, MAFIA, ethers.parseEther("1"))).to.be.revertedWith("betting closed");
  });

  it("reverts a bet on a nonexistent match", async () => {
    const { market, alice } = await opened();
    await expect(market.connect(alice).betProp(999, 0, MAFIA, ethers.parseEther("1"))).to.be.revertedWith("not open");
  });

  it("enforces MIN_BET and MAX_BET_PER_TX", async () => {
    const { market, alice, sched, matchId, faction } = await opened();
    await mineUpTo(sched.bettingOpenBlock);
    await expect(market.connect(alice).betProp(matchId, faction, MAFIA, ethers.parseEther("0.001"))).to.be.revertedWith("below min bet");
    await expect(market.connect(alice).betProp(matchId, faction, MAFIA, ethers.parseEther("10001"))).to.be.revertedWith("above max bet");
  });

  it("reverts a bet without sufficient allowance", async () => {
    const { market, token, alice, sched, matchId, faction } = await opened();
    await mineUpTo(sched.bettingOpenBlock);
    await token.connect(alice).approve(await market.getAddress(), 0); // revoke approval
    await expect(market.connect(alice).betProp(matchId, faction, MAFIA, ethers.parseEther("1"))).to.be.revertedWith("insufficient allowance");
  });

  it("accumulates pools + stakes and emits PropBetPlaced; pulls CHIP into escrow", async () => {
    const { market, token, alice, bob, sched, matchId, faction } = await opened();
    await mineUpTo(sched.bettingOpenBlock);
    const aBefore = await token.balanceOf(alice.address);
    await expect(market.connect(alice).betProp(matchId, faction, MAFIA, ethers.parseEther("2")))
      .to.emit(market, "PropBetPlaced");
    await market.connect(bob).betProp(matchId, faction, TOWN, ethers.parseEther("3"));
    await market.connect(alice).betProp(matchId, faction, MAFIA, ethers.parseEther("1"));

    const pr = await market.getProp(matchId, faction);
    expect(pr.pools[MAFIA]).to.equal(ethers.parseEther("3"));
    expect(pr.pools[TOWN]).to.equal(ethers.parseEther("3"));
    expect(await market.propStake(matchId, faction, MAFIA, alice.address)).to.equal(ethers.parseEther("3"));
    expect(await market.propStake(matchId, faction, TOWN, bob.address)).to.equal(ethers.parseEther("3"));
    // Alice's CHIP went into the contract.
    expect(aBefore - (await token.balanceOf(alice.address))).to.equal(ethers.parseEther("3"));
    expect(await token.balanceOf(await market.getAddress())).to.equal(ethers.parseEther("6"));
  });

  it("lockBetting reverts before close, transitions to Locked after", async () => {
    const { market, sched, matchId } = await opened();
    await expect(market.lockBetting(matchId)).to.be.revertedWith("betting still open");
    await mineUpTo(sched.bettingCloseBlock);
    await expect(market.lockBetting(matchId)).to.emit(market, "BettingLocked");
    expect((await market.matches(matchId)).state).to.equal(2); // Locked
  });
});

describe("MafiaMarket factory — settlement", () => {
  async function locked(nonce = "m-settle") {
    const { market, token, owner, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, nonce, teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: 5, schedule: sched }));
    const faction = await openFaction(market, owner);
    await mineUpTo(sched.bettingOpenBlock);
    // alice bets MAFIA, bob TOWN, so neither faction pool is empty (whoever wins has backers).
    await market.connect(alice).betProp(0, faction, MAFIA, ethers.parseEther("1"));
    await market.connect(bob).betProp(0, faction, TOWN, ethers.parseEther("3"));
    await mineUpTo(sched.bettingCloseBlock);
    return { market, token, alice, bob, fx, sched, matchId: 0, teeSigner, faction };
  }

  it("settles the faction market to the on-chain-computed winner and caches net pot", async () => {
    const { market, fx, matchId, faction } = await locked();
    await expect(market.settle(matchId, fx.moves, fx.roles, fx.salt, CID)).to.emit(market, "MatchSettled");
    const m = await market.matches(matchId);
    expect(m.state).to.equal(3); // Settled
    expect(m.transcriptCID).to.equal(CID);

    const pr = await market.getProp(matchId, faction);
    expect(pr.state).to.equal(PS.Resolved);
    expect(pr.winningOutcome).to.equal(fx.mafiaWins ? MAFIA : TOWN);
    // gross = 4 CHIP, fee = 2% = 0.08, netPot = 3.92 (the other markets are empty → fee-free Void)
    expect(pr.netPot).to.equal(ethers.parseEther("3.92"));
    expect(await market.protocolFeeAccrued()).to.equal(ethers.parseEther("0.08"));
  });

  it("can settle before the old close block (no minimum betting window)", async () => {
    const { market, owner, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-early-settle", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-early-settle", playerCount: 5, schedule: sched }));
    const faction = await openFaction(market, owner);
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice).betProp(0, faction, MAFIA, ethers.parseEther("1"));
    // Settle immediately — well before bettingCloseBlock — proving betting closes on settle, not on a block.
    await expect(market.settle(0, fx.moves, fx.roles, fx.salt, CID)).to.emit(market, "MatchSettled");
    expect((await market.matches(0)).state).to.equal(3); // Settled
  });

  it("reverts settle after the deadline", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-x", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-x", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await expect(market.settle(0, fx.moves, fx.roles, fx.salt, CID)).to.be.revertedWith("deadline passed");
  });

  it("reverts a bad role reveal", async () => {
    const { market, fx, matchId } = await locked();
    const badRoles = [...fx.roles];
    badRoles[0] = badRoles[0] === 0 ? 3 : 0;
    await expect(market.settle(matchId, fx.moves, badRoles, fx.salt, CID)).to.be.revertedWith("role reveal mismatch");
  });

  it("reverts a forged signature (wrong key)", async () => {
    const { market, fx, matchId } = await locked();
    const attacker = ethers.Wallet.createRandom();
    const env = await buildEnvelope(attacker, '{"nonce":"x","phase":"night","round":1,"player":0,"action":"kill","target":2}');
    const tampered = fx.moves.map((mv: any) => ({ ...mv }));
    tampered[0] = { decision: fx.moves[0].decision, ...env };
    await expect(market.settle(matchId, tampered, fx.roles, fx.salt, CID)).to.be.reverted;
  });

  it("MISTRIAL: a clean truncation (no faction wins) Voids the faction market — no draw fee", async () => {
    const { market, fx, matchId, faction } = await locked();
    // scriptedMatch breaks exactly when a faction wins, so the final move is the winning one; any strict legal prefix leaves the game unresolved -> mistrial -> Void.
    const truncated = fx.moves.slice(0, fx.moves.length - 1); // legal prefix, game unresolved
    await market.settle(matchId, truncated, fx.roles, fx.salt, CID);
    expect((await market.getProp(matchId, faction)).state).to.equal(PS.Void);
    expect(await market.protocolFeeAccrued()).to.equal(0); // Void is fee-free
  });

  it("VOID: engine winner with an empty winning pool resolves the faction market to Void", async () => {
    const { market, owner, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-void", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-void", playerCount: 5, schedule: sched }));
    const faction = await openFaction(market, owner);
    await mineUpTo(sched.bettingOpenBlock);
    // Bet ONLY the losing faction, leaving the winning side's pool empty.
    await market.connect(alice).betProp(0, faction, fx.mafiaWins ? TOWN : MAFIA, ethers.parseEther("2"));
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.getProp(0, faction)).state).to.equal(PS.Void);
  });
});

describe("MafiaMarket factory — faction claims", () => {
  // Bet so that BOTH factions have multiple bettors; settle; check pro-rata + conservation.
  async function settled(nonce = "m-claim") {
    const { market, token, owner, treasury, alice, bob, carol } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, nonce, teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: 5, schedule: sched }));
    const faction = await openFaction(market, owner);
    await mineUpTo(sched.bettingOpenBlock);
    const winOut = fx.mafiaWins ? MAFIA : TOWN;
    const loseOut = fx.mafiaWins ? TOWN : MAFIA;
    await market.connect(alice).betProp(0, faction, winOut, ethers.parseEther("1"));
    await market.connect(carol).betProp(0, faction, winOut, ethers.parseEther("3"));
    await market.connect(bob).betProp(0, faction, loseOut, ethers.parseEther("2"));
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    return { market, token, alice, bob, carol, fx, matchId: 0, faction };
  }

  it("pays winners pro-rata net of fee and conserves the pot", async () => {
    const { market, token, alice, bob, carol, matchId, faction } = await settled();
    // gross 6, fee 2% = 0.12, netPot 5.88, winningPool 4. alice 1/4 -> 1.47, carol 3/4 -> 4.41
    const a0 = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(matchId, faction);
    const a1 = await token.balanceOf(alice.address);
    expect(a1 - a0).to.equal(ethers.parseEther("1.47"));

    await market.connect(carol).claimProp(matchId, faction);
    await expect(market.connect(bob).claimProp(matchId, faction)).to.be.revertedWith("no winning stake");

    // Conservation: contract holds only fee + wei-dust after both winners claim.
    const bal = await token.balanceOf(await market.getAddress());
    const fee = ethers.parseEther("0.12");
    expect(bal - fee).to.be.lessThan(10n); // dust < a few wei
  });

  it("reverts double-claim", async () => {
    const { market, alice, matchId, faction } = await settled();
    await market.connect(alice).claimProp(matchId, faction);
    await expect(market.connect(alice).claimProp(matchId, faction)).to.be.revertedWith("already claimed");
  });

  it("MISTRIAL refunds full own stake (no draw fee)", async () => {
    const { market, token, owner, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-drawclaim", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-drawclaim", playerCount: 5, schedule: sched }));
    const faction = await openFaction(market, owner);
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice).betProp(0, faction, MAFIA, ethers.parseEther("1"));
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves.slice(0, fx.moves.length - 1), fx.roles, fx.salt, CID); // mistrial -> Void
    const a0 = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(0, faction);
    const a1 = await token.balanceOf(alice.address);
    expect(a1 - a0).to.equal(ethers.parseEther("1")); // full refund, no fee
  });

  it("VOID refunds full own stake", async () => {
    const { market, token, owner, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-voidclaim", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-voidclaim", playerCount: 5, schedule: sched }));
    const faction = await openFaction(market, owner);
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice).betProp(0, faction, fx.mafiaWins ? TOWN : MAFIA, ethers.parseEther("2"));
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID); // Void
    const a0 = await token.balanceOf(alice.address);
    await market.connect(alice).claimProp(0, faction);
    const a1 = await token.balanceOf(alice.address);
    expect(a1 - a0).to.equal(ethers.parseEther("2"));
  });

  it("reverts claim before settlement", async () => {
    const { market, owner, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-early", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-early", playerCount: 5, schedule: sched }));
    const faction = await openFaction(market, owner);
    await expect(market.connect(alice).claimProp(0, faction)).to.be.revertedWith("not settled");
  });

  it("isolates stakes across matchIds (no cross-match claim)", async () => {
    const { market, owner, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx0 = await buildSettlement(SEED, 5, "iso-0", teeSigner);
    const s0 = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx0.commit, teeSigner: teeSigner.address, nonce: "iso-0", playerCount: 5, schedule: s0 }));
    const f0 = await openFaction(market, owner, 0);
    const fx1 = await buildSettlement(SEED, 5, "iso-1", teeSigner);
    const s1 = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx1.commit, teeSigner: teeSigner.address, nonce: "iso-1", playerCount: 5, schedule: s1 }));
    const f1 = await openFaction(market, owner, 1);
    await mineUpTo(Math.max(s0.bettingOpenBlock, s1.bettingOpenBlock));
    await market.connect(alice).betProp(0, f0, fx0.mafiaWins ? MAFIA : TOWN, ethers.parseEther("1"));
    await market.connect(bob).betProp(1, f1, fx1.mafiaWins ? MAFIA : TOWN, ethers.parseEther("1"));
    await mineUpTo(Math.max(s0.bettingCloseBlock, s1.bettingCloseBlock));
    await market.settle(0, fx0.moves, fx0.roles, fx0.salt, CID);
    await market.settle(1, fx1.moves, fx1.roles, fx1.salt, CID);
    // Alice has no stake in match 1 -> cannot claim it, even though she won match 0.
    expect(await market.propStake(1, f1, MAFIA, alice.address)).to.equal(0);
    expect(await market.propStake(1, f1, TOWN, alice.address)).to.equal(0);
    await expect(market.connect(alice).claimProp(1, f1)).to.be.revertedWith("no winning stake");
    await market.connect(alice).claimProp(0, f0); // her match-0 claim still works
  });
});

describe("MafiaMarket factory — batch claim", () => {
  // Pro-rata payout on a resolved prop for a winning stake `s`: netPot * s / winningPool.
  async function propPayout(market: any, matchId: number, propIdx: number, s: bigint): Promise<bigint> {
    const pr = await market.getProp(matchId, propIdx);
    return (BigInt(pr.netPot) * s) / BigInt(pr.winningPool);
  }

  // A settled 5p match where alice holds THREE side positions: two winners (the faction headline + the
  // "who is the Mafia?" market backed on the real Mafia seat) and one loser (the round-1 "voted out"
  // market backed on a seat the vote didn't take — bob seeds the true outcome so that market Resolves
  // rather than Voids, making alice's bet a real loss).
  async function settledMulti(nonce = "m-batch") {
    const { market, token, owner, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, nonce, teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: 5, schedule: sched }));
    const faction = await openFaction(market, owner);   // headline market, floated at the tail (propIdx 2)
    const winSide = Number(await market.propCount(0));  // "who is the Mafia?" market, next tail
    await market.connect(owner).openMafiaSeatMarket(0);
    const loseSide = 0;                                 // the round-1 "voted out" market (minted first)
    await mineUpTo(sched.bettingOpenBlock);

    const winOut = fx.mafiaWins ? MAFIA : TOWN;
    const loseOut = fx.mafiaWins ? TOWN : MAFIA;
    const mafiaSeat = fx.roles.findIndex((r) => r === 0); // role enum: MAFIA == 0
    expect(mafiaSeat, "fixture must seat a Mafia").to.be.gte(0);
    // Round-1 voted-out market winner: the round-1 day-vote casualty (or "no one" == playerCount).
    const voWin = fx.firstVotedOut ?? 5;
    const voLose = voWin === 0 ? 1 : 0; // an outcome that is NOT the winner

    await market.connect(alice).betProp(0, faction, winOut, ethers.parseEther("1"));   // winner
    await market.connect(alice).betProp(0, winSide, mafiaSeat, ethers.parseEther("1")); // winner (the real Mafia)
    await market.connect(alice).betProp(0, loseSide, voLose, ethers.parseEther("1"));   // loser (a seat the vote didn't take)
    await market.connect(bob).betProp(0, faction, loseOut, ethers.parseEther("2"));     // seeds the faction pot
    await market.connect(bob).betProp(0, loseSide, voWin, ethers.parseEther("1"));      // resolves loseSide (alice's bet loses)

    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    return { market, token, alice, bob, matchId: 0, faction, winSide, loseSide };
  }

  it("pays every winning market in one tx, skips the losing one, and emits BatchClaimed", async () => {
    const { market, token, alice, matchId, faction, winSide, loseSide } = await settledMulti();
    const stake = ethers.parseEther("1");
    const expected = (await propPayout(market, matchId, faction, stake)) + (await propPayout(market, matchId, winSide, stake));

    const a0 = await token.balanceOf(alice.address);
    await expect(market.connect(alice).batchClaim(matchId, [faction, winSide, loseSide]))
      .to.emit(market, "BatchClaimed").withArgs(matchId, alice.address, 2, expected);
    const a1 = await token.balanceOf(alice.address);
    expect(a1 - a0).to.equal(expected); // faction + mafia-seat; the voted-out loser skipped

    expect(await market.propClaimed(matchId, faction, alice.address)).to.equal(true);
    expect(await market.propClaimed(matchId, winSide, alice.address)).to.equal(true);
    expect(await market.propClaimed(matchId, loseSide, alice.address)).to.equal(false); // losing → never marked
  });

  it("pays a duplicated index only once", async () => {
    const { market, token, alice, matchId, faction, winSide } = await settledMulti("m-batch-dup");
    const stake = ethers.parseEther("1");
    const expected = (await propPayout(market, matchId, faction, stake)) + (await propPayout(market, matchId, winSide, stake));
    const a0 = await token.balanceOf(alice.address);
    await expect(market.connect(alice).batchClaim(matchId, [faction, faction, winSide]))
      .to.emit(market, "BatchClaimed").withArgs(matchId, alice.address, 2, expected);
    expect((await token.balanceOf(alice.address)) - a0).to.equal(expected);
  });

  it("skips an already-claimed market and pays only the rest", async () => {
    const { market, token, alice, matchId, faction, winSide } = await settledMulti("m-batch-partial");
    await market.connect(alice).claimProp(matchId, winSide); // collect one individually first
    const stake = ethers.parseEther("1");
    const expected = await propPayout(market, matchId, faction, stake);
    const a0 = await token.balanceOf(alice.address);
    await expect(market.connect(alice).batchClaim(matchId, [faction, winSide]))
      .to.emit(market, "BatchClaimed").withArgs(matchId, alice.address, 1, expected);
    expect((await token.balanceOf(alice.address)) - a0).to.equal(expected);
  });

  it("reverts when nothing in the set is collectable (re-run, all-losing, or empty)", async () => {
    const { market, alice, bob, matchId, faction, winSide, loseSide } = await settledMulti("m-batch-empty");
    await market.connect(alice).batchClaim(matchId, [faction, winSide]); // drain the winners
    await expect(market.connect(alice).batchClaim(matchId, [faction, winSide])).to.be.revertedWith("nothing to claim");
    await expect(market.connect(alice).batchClaim(matchId, [loseSide])).to.be.revertedWith("nothing to claim"); // only a loser
    await expect(market.connect(alice).batchClaim(matchId, [])).to.be.revertedWith("nothing to claim");        // empty set
    await expect(market.connect(bob).batchClaim(matchId, [faction])).to.be.revertedWith("nothing to claim");   // bob backed the losing faction
  });

  it("tolerates an out-of-range index (skips it, pays the valid winners)", async () => {
    const { market, token, alice, matchId, faction, winSide } = await settledMulti("m-batch-oob");
    const count = Number(await market.propCount(matchId));
    const stake = ethers.parseEther("1");
    const expected = (await propPayout(market, matchId, faction, stake)) + (await propPayout(market, matchId, winSide, stake));
    const a0 = await token.balanceOf(alice.address);
    await market.connect(alice).batchClaim(matchId, [faction, count + 5, winSide]); // count+5 is out of range
    expect((await token.balanceOf(alice.address)) - a0).to.equal(expected);
  });

  it("reverts before settlement", async () => {
    const { market, owner, alice } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-batch-early", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-batch-early", playerCount: 5, schedule: sched }));
    const faction = await openFaction(market, owner);
    await expect(market.connect(alice).batchClaim(0, [faction])).to.be.revertedWith("not settled");
  });
});

describe("MafiaMarket factory — refund mode", () => {
  async function betThenIdle() {
    const { market, token, owner, alice, bob, stranger } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-refund", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-refund", playerCount: 5, schedule: sched }));
    const faction = await openFaction(market, owner);
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice).betProp(0, faction, MAFIA, ethers.parseEther("1"));
    await market.connect(bob).betProp(0, faction, TOWN, ethers.parseEther("2"));
    return { market, token, alice, bob, stranger, fx, sched, matchId: 0, faction };
  }

  it("enterRefundMode reverts before the deadline, works after", async () => {
    const { market, sched, matchId } = await betThenIdle();
    await mineUpTo(sched.bettingCloseBlock);
    await expect(market.enterRefundMode(matchId)).to.be.revertedWith("deadline not passed");
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await expect(market.enterRefundMode(matchId)).to.emit(market, "RefundModeEntered");
    expect((await market.matches(matchId)).state).to.equal(4); // RefundMode
  });

  it("refundProp returns each bettor's full stake; double-refund reverts", async () => {
    const { market, token, alice, sched, matchId, faction } = await betThenIdle();
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(matchId);
    const a0 = await token.balanceOf(alice.address);
    await market.connect(alice).refundProp(matchId, faction);
    const a1 = await token.balanceOf(alice.address);
    expect(a1 - a0).to.equal(ethers.parseEther("1"));
    await expect(market.connect(alice).refundProp(matchId, faction)).to.be.revertedWith("already refunded");
  });

  it("refundProp reverts before refund mode and for a non-bettor", async () => {
    const { market, alice, stranger, sched, matchId, faction } = await betThenIdle();
    await expect(market.connect(alice).refundProp(matchId, faction)).to.be.revertedWith("not refund mode");
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(matchId);
    await expect(market.connect(stranger).refundProp(matchId, faction)).to.be.revertedWith("no stake");
  });

  it("settle is blocked once in refund mode", async () => {
    const { market, fx, sched, matchId } = await betThenIdle();
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(matchId);
    await expect(market.settle(matchId, fx.moves, fx.roles, fx.salt, CID)).to.be.revertedWith("not settleable");
  });

  // alice stakes on the faction headline + the round-1 voted-out market (propIdx 0); the match is
  // abandoned → RefundMode.
  async function abandonedMulti() {
    const { market, token, owner, alice, stranger } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-batch-refund", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-batch-refund", playerCount: 5, schedule: sched }));
    const faction = await openFaction(market, owner);
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice).betProp(0, faction, MAFIA, ethers.parseEther("1"));
    await market.connect(alice).betProp(0, 0, 2, ethers.parseEther("1")); // round-1 voted-out market (propIdx 0), any outcome
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(0);
    return { market, token, alice, stranger, matchId: 0, faction };
  }

  it("batchRefund returns every listed stake in one tx; skips unbet props; re-run reverts", async () => {
    const { market, token, alice, matchId, faction } = await abandonedMulti();
    const a0 = await token.balanceOf(alice.address);
    // faction (1) + propIdx 0 (1) = 2; propIdx 3 is out of range → skipped, doesn't revert the batch.
    await expect(market.connect(alice).batchRefund(matchId, [faction, 0, 3]))
      .to.emit(market, "BatchClaimed").withArgs(matchId, alice.address, 2, ethers.parseEther("2"));
    expect((await token.balanceOf(alice.address)) - a0).to.equal(ethers.parseEther("2"));
    expect(await market.propClaimed(matchId, faction, alice.address)).to.equal(true);
    expect(await market.propClaimed(matchId, 0, alice.address)).to.equal(true);
    await expect(market.connect(alice).batchRefund(matchId, [faction, 0])).to.be.revertedWith("nothing to refund");
  });

  it("batchRefund reverts before refund mode and for a non-bettor", async () => {
    const { market, alice, stranger, sched, matchId, faction } = await betThenIdle();
    await expect(market.connect(alice).batchRefund(matchId, [faction])).to.be.revertedWith("not refund mode");
    await mineUpTo(sched.settlementDeadlineBlock + 1);
    await market.enterRefundMode(matchId);
    await expect(market.connect(stranger).batchRefund(matchId, [faction])).to.be.revertedWith("nothing to refund");
  });
});

describe("MafiaMarket factory — protocol fees", () => {
  it("only treasury can withdraw; sweep transfers accrued fees", async () => {
    const { market, token, owner, treasury, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "m-fee", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "m-fee", playerCount: 5, schedule: sched }));
    const faction = await openFaction(market, owner);
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice).betProp(0, faction, fx.mafiaWins ? MAFIA : TOWN, ethers.parseEther("1"));
    await market.connect(bob).betProp(0, faction, fx.mafiaWins ? TOWN : MAFIA, ethers.parseEther("3"));
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);

    await expect(market.connect(alice).withdrawProtocolFees()).to.be.revertedWith("not treasury");
    const t0 = await token.balanceOf(treasury.address);
    await market.connect(treasury).withdrawProtocolFees();
    const t1 = await token.balanceOf(treasury.address);
    expect(t1 - t0).to.equal(ethers.parseEther("0.08")); // 2% of 4
    expect(await market.protocolFeeAccrued()).to.equal(0);
  });

  it("reverts withdraw when nothing accrued", async () => {
    const { market, treasury } = await deploy();
    await expect(market.connect(treasury).withdrawProtocolFees()).to.be.revertedWith("nothing to withdraw");
  });
});
