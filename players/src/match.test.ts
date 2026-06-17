import { describe, it, expect } from "vitest";
import { runMatch } from "@turingpits/engine";
import { playMatch } from "./match.js";
import { Player } from "./player.js";
import { MockLocalProvider } from "./provider.js";
import { verifyAttestation } from "./attestation.js";
import type { Persona } from "./types.js";

// Distinct fixed keys are unnecessary — one shared provider models one TEE provider key
// signing every seat's decision, exactly as the on-chain verifier expects.
const PROVIDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SEED = "0x" + "11".repeat(32);
const NONCE = "match-001";

const personas: Persona[] = [
  { seat: 0, name: "Ada", blurb: "an analyst" },
  { seat: 1, name: "Boris", blurb: "a skeptic" },
  { seat: 2, name: "Cleo", blurb: "a peacemaker" },
  { seat: 3, name: "Dmitri", blurb: "a contrarian" },
  { seat: 4, name: "Esme", blurb: "a strategist" },
];

function buildPlayers() {
  const provider = new MockLocalProvider(PROVIDER_KEY);
  return personas.map(() => new Player(provider));
}

describe("playMatch (Day 2 exit criteria)", () => {
  it("runs a full attested Mafia match to a declared winner", async () => {
    const result = await playMatch({
      seed: SEED,
      n: 5,
      nonce: NONCE,
      personas,
      players: buildPlayers(),
    });

    expect(result.winner === "MAFIA" || result.winner === "TOWN").toBe(true);
    expect(result.turns.length).toBeGreaterThan(0);
  });

  it("carries a valid, locally-verifiable attestation on every decision", async () => {
    const result = await playMatch({
      seed: SEED,
      n: 5,
      nonce: NONCE,
      personas,
      players: buildPlayers(),
    });

    for (const turn of result.turns) {
      expect(verifyAttestation(turn.attestation)).toBe(true);
      // The attestation binds the exact decision bytes the contract will reconstruct.
      expect(turn.attestation.signedText).toContain(`"target":${turn.structuredDecision.target}`);
    }
  });

  it("captures decisions that the moderator reproduces to the same winner", async () => {
    const result = await playMatch({
      seed: SEED,
      n: 5,
      nonce: NONCE,
      personas,
      players: buildPlayers(),
    });

    // Feed the captured structured decisions back through the pure moderator: the
    // transcript is internally consistent and replays to the same outcome.
    const decisions = result.turns.map((t) => t.structuredDecision);
    const replay = runMatch(SEED, 5, NONCE, decisions);
    expect(replay.winner).toBe(result.winner);
  });

  it("is deterministic for a fixed seed and fixed provider key", async () => {
    const a = await playMatch({ seed: SEED, n: 5, nonce: NONCE, personas, players: buildPlayers() });
    const b = await playMatch({ seed: SEED, n: 5, nonce: NONCE, personas, players: buildPlayers() });
    expect(b.winner).toBe(a.winner);
    expect(b.turns.length).toBe(a.turns.length);
  });
});
