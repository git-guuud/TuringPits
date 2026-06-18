import { expect } from "chai";
import { ethers } from "hardhat";

// Cross-layer proof: a match driven by the real `players/` layer (Player + provider +
// playMatch) produces calldata that the deployed MafiaMarket settles unchanged. The provider
// here is MockLocalProvider — a LOCAL test key, not a 0G TEE provider (source "MOCK-local") —
// but it emits the SAME live-confirmed envelope shape ZeroGDirectProvider does, so this
// exercises the exact attestation → toSettlementMove → settle() path the live provider uses.
// Only the signer's identity differs between this and a funded `qwen2.5-omni` match.

const SEED = "0x" + "11".repeat(32);
const NONCE = "integration-match-1";
const ROLE_ENUM: Record<string, number> = { MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 };

const PERSONAS = [
  { seat: 0, name: "Ada", blurb: "an analyst" },
  { seat: 1, name: "Boris", blurb: "a skeptic" },
  { seat: 2, name: "Cleo", blurb: "a peacemaker" },
  { seat: 3, name: "Dmitri", blurb: "a contrarian" },
  { seat: 4, name: "Esme", blurb: "a strategist" },
];

describe("players ↔ MafiaMarket integration", () => {
  it("a playMatch transcript settles on-chain to the engine-declared winner", async () => {
    const players = await import("@turingpits/players");
    const engine = await import("@turingpits/engine");

    const teeSigner = ethers.Wallet.createRandom();

    // 1. Run a full attested match through the player layer (one shared provider = one TEE key).
    const provider = new players.MockLocalProvider(teeSigner.privateKey);
    const result = await players.playMatch({
      seed: SEED,
      n: 5,
      nonce: NONCE,
      personas: PERSONAS,
      players: PERSONAS.map(() => new players.Player(provider)),
    });
    expect(result.winner === "MAFIA" || result.winner === "TOWN").to.equal(true);

    // 2. Map attested turns to settlement calldata.
    const moves = result.turns.map((t) => players.toSettlementMove(t));

    // 3. Role commit/reveal from the same seed the match used.
    const roleNames = engine.assignRoles(SEED, 5) as string[];
    const roles = roleNames.map((r) => ROLE_ENUM[r]);
    const salt = engine.generateSalt();
    const commit = engine.commitRoles(roleNames, salt);

    // 4. Deploy + open the market with the provider metadata the mock signed under.
    const [host, alice, bob] = await ethers.getSigners();
    const m = players.MOCK_PROVIDER_META;
    const Market = await ethers.getContractFactory("MafiaMarket");
    const market = await Market.connect(host).deploy();
    await market.openMarket(commit, teeSigner.address, m.providerType, m.providerIdentity, m.tlsFingerprint, NONCE, 5);

    // 5. Bet, lock, settle with the player-produced moves.
    await market.connect(alice).placeBet(1, { value: ethers.parseEther("1") }); // YES (Mafia)
    await market.connect(bob).placeBet(0, { value: ethers.parseEther("2") });   // NO (Town)
    await market.lockBetting();
    await market.settle(moves, roles, salt);

    expect(await market.state()).to.equal(2); // Settled
    const expectedSide = result.winner === "MAFIA" ? 1 : 0;
    expect(await market.winningSide()).to.equal(expectedSide);
  });
});
