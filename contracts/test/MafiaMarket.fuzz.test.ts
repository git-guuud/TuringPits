import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, buildSettlement } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32);
const CID = "0x" + "cd".repeat(32);

// Deterministic PRNG so failures reproduce.
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("MafiaMarket — conservation property (fuzz)", () => {
  it("for random bet sequences, Σ claims + fee == gross within dust and no payout exceeds gross", async () => {
    const rand = mulberry32(42);
    for (let iter = 0; iter < 8; iter++) {
      const signers = await ethers.getSigners();
      const [owner, treasury] = signers;
      const bettors = signers.slice(2, 8);
      const Market = await ethers.getContractFactory("MafiaMarket");
      const market = await Market.connect(owner).deploy(treasury.address);
      const teeSigner = ethers.Wallet.createRandom();
      const nonce = `fuzz-${iter}`;
      const fx = await buildSettlement(SEED, 5, nonce, teeSigner);
      const sched = await defaultSchedule(ethers.provider);
      await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: 5, schedule: sched }));
      await mineUpTo(sched.bettingOpenBlock);

      // Random bets; force at least one bet on the winning side so the outcome is Yes/No (not Void).
      const winFn = fx.mafiaWins ? "betYes" : "betNo";
      const loseFn = fx.mafiaWins ? "betNo" : "betYes";
      await market.connect(bettors[0])[winFn](0, { value: ethers.parseEther("1") });
      for (let i = 1; i < bettors.length; i++) {
        const amt = ethers.parseEther((0.05 + rand() * 5).toFixed(4));
        await market.connect(bettors[i])[rand() < 0.5 ? winFn : loseFn](0, { value: amt });
      }
      await mineUpTo(sched.bettingCloseBlock);
      await market.settle(0, fx.moves, fx.roles, fx.salt, CID);

      const m = await market.matches(0);
      const gross = m.poolYes + m.poolNo;
      let claimsTotal = 0n;
      for (const b of bettors) {
        const stake = (await market.stakeYes(0, b.address)) + (await market.stakeNo(0, b.address));
        const won = fx.mafiaWins ? await market.stakeYes(0, b.address) : await market.stakeNo(0, b.address);
        if (won === 0n) continue;
        const before = await ethers.provider.getBalance(await market.getAddress());
        await market.connect(b).claim(0);
        const after = await ethers.provider.getBalance(await market.getAddress());
        const payout = before - after;
        expect(payout).to.be.lessThanOrEqual(gross); // no payout exceeds the whole pot
        claimsTotal += payout;
        expect(stake).to.be.greaterThan(0n);
      }
      const fee = await market.protocolFeeAccrued();
      const dust = gross - (claimsTotal + fee);
      expect(dust).to.be.greaterThanOrEqual(0n);
      expect(dust).to.be.lessThan(BigInt(bettors.length)); // wei-scale floor-division dust only
    }
  });
});
