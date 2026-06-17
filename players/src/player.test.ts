import { describe, it, expect } from "vitest";
import { encodeDecision } from "@turingpits/engine";
import { Player } from "./player.js";
import { MockLocalProvider } from "./provider.js";
import { verifyAttestation } from "./attestation.js";
import type { Attestation, InferenceProvider, TurnContext } from "./types.js";

const FIXED_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const ctx: TurnContext = {
  persona: { seat: 2, name: "Ada", blurb: "an analyst" },
  role: "MAFIA",
  alive: [0, 1, 2, 3, 4],
  transcript: [[0, "seat 3 is quiet"]],
  decisionStub: { nonce: "deadbeef", phase: "day", round: 1, player: 2, action: "vote" },
  legalTargets: [0, 1, 3, 4],
};

describe("Player.takeTurn", () => {
  it("produces speech, a legal structured decision, and a verifying attestation", async () => {
    const player = new Player(new MockLocalProvider(FIXED_KEY));
    const turn = await player.takeTurn(ctx);

    expect(turn.speech.length).toBeGreaterThan(0);
    expect(turn.structuredDecision.player).toBe(2);
    expect(ctx.legalTargets).toContain(turn.structuredDecision.target);
    expect(verifyAttestation(turn.attestation)).toBe(true);
  });

  it("attests the exact canonical decision string (binds the signature to the decision)", async () => {
    const player = new Player(new MockLocalProvider(FIXED_KEY));
    const turn = await player.takeTurn(ctx);
    expect(turn.attestation.signedText).toBe(encodeDecision(turn.structuredDecision));
  });

  it("throws if the provider's decision output is illegal (never silently corrected)", async () => {
    const rogue: InferenceProvider = {
      async complete(prompt: string) {
        const text = prompt.startsWith("You are seat") ? '{"nonce":"x"}' : "chatter";
        const att: Attestation = {
          signedText: text,
          signature: "0x00",
          signerAddress: "0x0000000000000000000000000000000000000000",
          source: "MOCK-local",
        };
        return { text, attestation: att };
      },
    };
    await expect(new Player(rogue).takeTurn(ctx)).rejects.toThrow();
  });
});
