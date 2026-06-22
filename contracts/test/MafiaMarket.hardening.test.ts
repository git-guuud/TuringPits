import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, buildSettlement, deployMarket, fundBettors } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);
const DUMMY_COMMIT = "0x" + "aa".repeat(32);

async function deploy() {
  const signers = await ethers.getSigners();
  const [owner, treasury, alice, bob] = signers;
  const { market, token } = await deployMarket(owner, treasury);
  // Fund the signers any test in this file bets from (indices 2..7).
  await fundBettors(token, await market.getAddress(), signers.slice(2, 8));
  return { market, token, owner, treasury, alice, bob };
}

// Recompute the on-chain role commit: sha256(packed role bytes ++ salt).
function commitFor(roles: number[], salt: string): string {
  return ethers.sha256(ethers.concat([Uint8Array.from(roles), ethers.getBytes(salt)]));
}

describe("MafiaMarket — settle access control (reveal front-run fix)", () => {
  it("reverts when a non-owner calls settle, even with the full valid reveal", async () => {
    const { market, alice, bob } = await deploy();
    const stranger = (await ethers.getSigners())[6];
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "hard-acl", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "hard-acl", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice).betYes(0, ethers.parseEther("1"));
    await market.connect(bob).betNo(0, ethers.parseEther("1"));
    await mineUpTo(sched.bettingCloseBlock);

    // A front-runner holding the mempool reveal cannot settle (and so cannot truncate → Draw).
    await expect(
      market.connect(stranger).settle(0, fx.moves, fx.roles, fx.salt, CID),
    ).to.be.revertedWith("not owner");

    // The legitimate host path still works.
    await expect(market.settle(0, fx.moves, fx.roles, fx.salt, CID)).to.emit(market, "MatchSettled");
  });
});

describe("MafiaMarket — role composition enforcement", () => {
  it("reverts settle when revealed roles have a non-canonical composition", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "hard-comp", teeSigner);
    const sched = await defaultSchedule(ethers.provider);

    // Relabel one TOWN(3) seat as a second MAFIA(0): commit still matches, but 5-player
    // composition requires exactly ONE mafia. A malicious host cannot inflate the mafia count.
    const badRoles = [...fx.roles];
    const townIdx = badRoles.indexOf(3);
    expect(townIdx).to.be.greaterThanOrEqual(0);
    badRoles[townIdx] = 0; // MAFIA
    const badCommit = commitFor(badRoles, fx.salt);

    await market.createMatch(createParams({ roleCommit: badCommit, teeSigner: teeSigner.address, nonce: "hard-comp", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingCloseBlock);
    await expect(market.settle(0, fx.moves, badRoles, fx.salt, CID)).to.be.revertedWith("bad composition");
  });

  it("still accepts the canonical composition the engine assigns", async () => {
    const { market, alice, bob } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "hard-comp-ok", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "hard-comp-ok", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice).betYes(0, ethers.parseEther("1"));
    await market.connect(bob).betNo(0, ethers.parseEther("1"));
    await mineUpTo(sched.bettingCloseBlock);
    await expect(market.settle(0, fx.moves, fx.roles, fx.salt, CID)).to.emit(market, "MatchSettled");
  });
});

describe("MafiaMarket — createMatch input validation", () => {
  it("reverts a zero roleCommit (would brick settlement)", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    await expect(
      market.createMatch(createParams({ roleCommit: ethers.ZeroHash, teeSigner: teeSigner.address, nonce: "ok-nonce", playerCount: 5, schedule: sched })),
    ).to.be.revertedWith("zero role commit");
  });

  it("reverts an empty nonce", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    await expect(
      market.createMatch(createParams({ roleCommit: DUMMY_COMMIT, teeSigner: teeSigner.address, nonce: "", playerCount: 5, schedule: sched })),
    ).to.be.revertedWith("bad nonce");
  });

  it("reverts a nonce with a control char (would diverge from JSON.stringify binding)", async () => {
    const { market } = await deploy();
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    await expect(
      market.createMatch(createParams({ roleCommit: DUMMY_COMMIT, teeSigner: teeSigner.address, nonce: "m\n1", playerCount: 5, schedule: sched })),
    ).to.be.revertedWith("bad nonce");
  });
});

describe("MafiaMarket — ownership transfer", () => {
  it("lets the owner hand off; new owner can create, old owner cannot", async () => {
    const { market, owner } = await deploy();
    const newOwner = (await ethers.getSigners())[7];
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);

    await expect(market.transferOwnership(newOwner.address))
      .to.emit(market, "OwnershipTransferred")
      .withArgs(owner.address, newOwner.address);
    expect(await market.owner()).to.equal(newOwner.address);

    await market.connect(newOwner).createMatch(createParams({ roleCommit: DUMMY_COMMIT, teeSigner: teeSigner.address, nonce: "by-new", playerCount: 5, schedule: sched }));
    const s2 = await defaultSchedule(ethers.provider);
    await expect(
      market.createMatch(createParams({ roleCommit: DUMMY_COMMIT, teeSigner: teeSigner.address, nonce: "by-old", playerCount: 5, schedule: s2 })),
    ).to.be.revertedWith("not owner");
  });

  it("reverts transfer to the zero address and from a non-owner", async () => {
    const { market, alice } = await deploy();
    await expect(market.transferOwnership(ethers.ZeroAddress)).to.be.revertedWith("zero owner");
    await expect(market.connect(alice).transferOwnership(alice.address)).to.be.revertedWith("not owner");
  });
});

describe("MafiaMarket — conservation for Draw and Void with multiple bettors", () => {
  it("DRAW: Σ claims + fee == gross within wei-dust", async () => {
    const { market, token } = await deploy();
    const signers = await ethers.getSigners();
    const bettors = signers.slice(2, 6);
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "cons-draw", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "cons-draw", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    const amts = ["1.3", "0.7", "2.1", "0.05"];
    for (let i = 0; i < bettors.length; i++) {
      const fn = i % 2 === 0 ? "betYes" : "betNo";
      await market.connect(bettors[i])[fn](0, ethers.parseEther(amts[i]));
    }
    await mineUpTo(sched.bettingCloseBlock);
    // Truncate to force Draw (every bettor refundable minus the draw fee).
    await market.settle(0, fx.moves.slice(0, fx.moves.length - 1), fx.roles, fx.salt, CID);
    expect((await market.matches(0)).outcome).to.equal(3); // Draw

    const m = await market.matches(0);
    const gross = m.poolYes + m.poolNo;
    let claimsTotal = 0n;
    for (const b of bettors) {
      const before = await token.balanceOf(await market.getAddress());
      await market.connect(b).claim(0);
      const after = await token.balanceOf(await market.getAddress());
      claimsTotal += before - after;
    }
    const fee = await market.protocolFeeAccrued();
    const dust = gross - (claimsTotal + fee);
    expect(dust).to.be.greaterThanOrEqual(0n);
    expect(dust).to.be.lessThan(BigInt(bettors.length + 1)); // wei-scale floor dust only
  });

  it("VOID: Σ refunds == gross exactly and drains the match", async () => {
    const { market, token } = await deploy();
    const signers = await ethers.getSigners();
    const bettors = signers.slice(2, 5);
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "cons-void", teeSigner);
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "cons-void", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);
    // Everyone bets the LOSING side → winning pool empty → Void.
    const loseFn = fx.mafiaWins ? "betNo" : "betYes";
    const amts = ["1.0", "2.5", "0.4"];
    for (let i = 0; i < bettors.length; i++) {
      await market.connect(bettors[i])[loseFn](0, ethers.parseEther(amts[i]));
    }
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.matches(0)).outcome).to.equal(4); // Void

    const m = await market.matches(0);
    const gross = m.poolYes + m.poolNo;
    let refundTotal = 0n;
    for (const b of bettors) {
      const before = await token.balanceOf(await market.getAddress());
      await market.connect(b).claim(0);
      const after = await token.balanceOf(await market.getAddress());
      refundTotal += before - after;
    }
    expect(refundTotal).to.equal(gross); // full refund, no fee, no dust
    expect(await market.protocolFeeAccrued()).to.equal(0n);
    expect(await token.balanceOf(await market.getAddress())).to.equal(0n);
  });
});
