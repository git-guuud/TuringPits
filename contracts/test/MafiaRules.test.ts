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

  it("records each round's day-vote elimination as the engine does (the per-round 'voted out' outcome)", async () => {
    const h = await deploy();
    const engine = await import("@turingpits/engine");
    // n=6: the scripted strategy convicts in round 1 AND round 2 before the match ends, so the
    // per-round 'voted out' truth spans multiple rounds (n=5 ends after a single day vote).
    const seed = "0x" + "11".repeat(32);
    const nonce = "rules-match-1";
    const { decisions, votedOutRound } = await scriptedMatch(seed, 6, nonce);
    const roles = engine.assignRoles(seed, 6).map((r: string) => ({ MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 }[r]));

    const onchain = (await h.votedOutRounds(roles, decisions.map(toSol))).map((x: bigint) => Number(x));
    expect(onchain).to.deep.equal(votedOutRound);
    // sanity: the scripted strategy convicts every day, so multiple rounds record a vote-out
    expect(votedOutRound.some((r) => r === 1), "someone is voted out in round 1").to.equal(true);
    expect(votedOutRound.some((r) => r >= 2), "the per-round market spans more than one round").to.equal(true);
  });

  it("records each seat's round of death as the engine does (the 'round of death' outcome)", async () => {
    const h = await deploy();
    const engine = await import("@turingpits/engine");
    const seed = "0x" + "11".repeat(32);
    const nonce = "rules-match-1";
    const { decisions, deathRound } = await scriptedMatch(seed, 5, nonce);
    const roles = engine.assignRoles(seed, 5).map((r: string) => ({ MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 }[r]));

    const onchain = (await h.deathRounds(roles, decisions.map(toSol))).map((x: bigint) => Number(x));
    expect(onchain).to.deep.equal(deathRound);
    // sanity: at least one seat fell in round 1 (the opening round the side market keys on)
    expect(deathRound.some((r) => r === 1), "someone dies in round 1").to.equal(true);
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
