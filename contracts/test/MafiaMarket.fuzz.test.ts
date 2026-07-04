import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { defaultSchedule, createParams, buildSettlement, deployMarket, fundBettors, openFaction, FACTION_OUT } from "./helpers/market";

const MAFIA = FACTION_OUT.MAFIA;
const TOWN = FACTION_OUT.TOWN;

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
      const { market, token } = await deployMarket(owner, treasury);
      await fundBettors(token, await market.getAddress(), bettors);
      const teeSigner = ethers.Wallet.createRandom();
      const nonce = `fuzz-${iter}`;
      const fx = await buildSettlement(SEED, 5, nonce, teeSigner);
      const sched = await defaultSchedule(ethers.provider);
      await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce, playerCount: 5, schedule: sched }));
      const faction = await openFaction(market, owner);
      await mineUpTo(sched.bettingOpenBlock);

      // Random bets on the faction market; force at least one bet on the winning side so the outcome
      // resolves (not Void).
      const winOut = fx.mafiaWins ? MAFIA : TOWN;
      const loseOut = fx.mafiaWins ? TOWN : MAFIA;
      await market.connect(bettors[0]).betProp(0, faction, winOut, ethers.parseEther("1"));
      for (let i = 1; i < bettors.length; i++) {
        const amt = ethers.parseEther((0.05 + rand() * 5).toFixed(4));
        await market.connect(bettors[i]).betProp(0, faction, rand() < 0.5 ? winOut : loseOut, amt);
      }
      await mineUpTo(sched.bettingCloseBlock);
      await market.settle(0, fx.moves, fx.roles, fx.salt, CID);

      const pr = await market.getProp(0, faction);
      const gross = pr.pools[MAFIA] + pr.pools[TOWN];
      let claimsTotal = 0n;
      for (const b of bettors) {
        const stake = (await market.propStake(0, faction, MAFIA, b.address)) + (await market.propStake(0, faction, TOWN, b.address));
        const won = await market.propStake(0, faction, winOut, b.address);
        if (won === 0n) continue;
        const before = await token.balanceOf(await market.getAddress());
        await market.connect(b).claimProp(0, faction);
        const after = await token.balanceOf(await market.getAddress());
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
