import { expect } from "chai";
import { ethers } from "hardhat";
import { scriptedMatch, toSol } from "./helpers/match";

describe("MafiaRules", () => {
  async function deploy() {
    const H = await ethers.getContractFactory("MafiaRulesHarness");
    return await H.deploy();
  }

  it("computes the same winner as the engine for a full scripted match", async () => {
    const h = await deploy();
    const engine = await import("@turingpits/engine");
    const seed = "0x" + "11".repeat(32);
    const nonce = "rules-match-1";
    const { decisions, mafiaWins } = await scriptedMatch(seed, 5, nonce);
    const roles = engine.assignRoles(seed, 5).map((r: string) => ({ MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 }[r]));

    const [over, onchainMafiaWins] = await h.winner(roles, decisions.map(toSol));
    expect(over).to.equal(true);
    expect(onchainMafiaWins).to.equal(mafiaWins);
  });

  it("reverts on an out-of-order decision", async () => {
    const h = await deploy();
    const engine = await import("@turingpits/engine");
    const seed = "0x" + "22".repeat(32);
    const roles = engine.assignRoles(seed, 5).map((r: string) => ({ MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 }[r]));
    // A day-vote decision submitted first, while the game opens on night round 1.
    const bad = [{ phase: 1, round: 1, player: 0, action: 3, target: 1 }];
    await expect(h.winner(roles, bad)).to.be.revertedWith("out of order");
  });
});
