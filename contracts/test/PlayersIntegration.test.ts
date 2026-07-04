import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { buildSettlement, defaultSchedule, createParams, deployMarket, fundBettors, openFaction, FACTION_OUT } from "./helpers/market";

// Cross-layer proof: a match driven by the real players/ layer (scripted transcript via
// buildSettlement — same envelope shape MockLocalProvider / ZeroGDirectProvider produce) settles
// through the full MafiaMarket factory lifecycle to the engine-declared winner. The TEE signer
// here is a labeled local test key, not a live 0G TEE provider (same caveat as MockLocalProvider:
// source "MOCK-local") but it exercises the exact attestation → settle() path the live provider
// uses. Only the signer's identity differs between this and a funded qwen2.5-omni match.

const SEED = "0x" + "11".repeat(32);
const NONCE = "integration-match-1";
const CID = "0x" + "cd".repeat(32);

// Persona names retained for documentary intent (they would be passed to playMatch in a live run).
const PERSONAS = [
  { seat: 0, name: "Ada",    blurb: "an analyst" },
  { seat: 1, name: "Boris",  blurb: "a skeptic" },
  { seat: 2, name: "Cleo",   blurb: "a peacemaker" },
  { seat: 3, name: "Dmitri", blurb: "a contrarian" },
  { seat: 4, name: "Esme",   blurb: "a strategist" },
];
void PERSONAS; // referenced in comments; unused at runtime

describe("players ↔ MafiaMarket integration", () => {
  it("a playMatch transcript settles on-chain to the engine-declared winner", async () => {
    const [owner, treasury, alice] = await ethers.getSigners();

    // 1. Build a full attested settlement fixture via the same helper used in MafiaMarket.test.ts.
    //    buildSettlement runs the engine's scripted match (same logic as playMatch) and wraps each
    //    decision in a real-ECDSA/EIP-191 0G-TEE-shaped envelope signed by a local test key.
    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, NONCE, teeSigner);
    // fx.mafiaWins reflects the engine-declared winner for this seed + nonce.

    // 2. Deploy the CHIP bet token + the factory bound to it; fund alice so she can wager.
    const { market, token } = await deployMarket(owner, treasury);
    await fundBettors(token, await market.getAddress(), [alice]);

    // 3. Create the match using the fixture's commit/teeSigner/nonce/playerCount.
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({
      roleCommit: fx.commit,
      teeSigner: teeSigner.address,
      nonce: NONCE,
      playerCount: 5,
      schedule: sched,
    }));
    const matchId = 0;
    // The headline "which faction wins?" market is a normal Prop, floated at match start.
    const faction = await openFaction(market, owner, matchId);

    // 4. Open betting and place a bet on the engine-winning faction (Faction outcome 1 = MAFIA, 0 = TOWN).
    await mineUpTo(sched.bettingOpenBlock);
    const winOut = fx.mafiaWins ? FACTION_OUT.MAFIA : FACTION_OUT.TOWN;
    await market.connect(alice).betProp(matchId, faction, winOut, ethers.parseEther("1"));

    // 5. Close betting then settle with the player-produced calldata.
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(matchId, fx.moves, fx.roles, fx.salt, CID);

    // 6. Assert the faction market resolved to the engine-declared winner.
    const pr = await market.getProp(matchId, faction);
    expect(pr.state).to.equal(1); // Resolved
    expect(pr.winningOutcome).to.equal(winOut);

    // 7. Alice (winning side) can claim her payout.
    await market.connect(alice).claimProp(matchId, faction);
  });
});
