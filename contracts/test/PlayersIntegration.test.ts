import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { buildSettlement, defaultSchedule, createParams } from "./helpers/market";

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

    // 2. Deploy the factory with a treasury.
    const Market = await ethers.getContractFactory("MafiaMarket");
    const market = await Market.connect(owner).deploy(treasury.address);

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

    // 4. Open betting and place a bet on the engine-winning side.
    await mineUpTo(sched.bettingOpenBlock);
    await market.connect(alice)[fx.mafiaWins ? "betYes" : "betNo"](matchId, {
      value: ethers.parseEther("1"),
    });

    // 5. Close betting then settle with the player-produced calldata.
    await mineUpTo(sched.bettingCloseBlock);
    await market.settle(matchId, fx.moves, fx.roles, fx.salt, CID);

    // 6. Assert the on-chain outcome matches the engine-declared winner.
    //    Outcome.Yes = 1 (Mafia wins), Outcome.No = 2 (Town wins).
    const m = await market.matches(matchId);
    expect(m.outcome).to.equal(fx.mafiaWins ? 1 : 2);

    // 7. Alice (winning side) can claim her payout.
    await market.connect(alice).claim(matchId);
  });
});
