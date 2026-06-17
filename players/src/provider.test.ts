import { describe, it, expect } from "vitest";
import { verifyAttestation } from "./attestation.js";
import { parseDecision } from "./decision.js";
import { buildDecisionPrompt, buildSpeechPrompt } from "./prompt.js";
import { MockLocalProvider } from "./provider.js";
import type { TurnContext } from "./types.js";

const FIXED_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const ctx: TurnContext = {
  persona: { seat: 2, name: "Ada", blurb: "an analyst" },
  role: "MAFIA",
  alive: [0, 1, 2, 3, 4],
  transcript: [],
  decisionStub: { nonce: "deadbeef", phase: "day", round: 1, player: 2, action: "vote" },
  legalTargets: [0, 1, 3, 4],
};

describe("MockLocalProvider", () => {
  it("returns an attestation that verifies and is labeled MOCK-local (never a real TEE)", async () => {
    const provider = new MockLocalProvider(FIXED_KEY);
    const { attestation } = await provider.complete("say something");

    expect(attestation.source).toBe("MOCK-local");
    expect(verifyAttestation(attestation)).toBe(true);
  });

  it("signs exactly the text it returns", async () => {
    const provider = new MockLocalProvider(FIXED_KEY);
    const { text, attestation } = await provider.complete("say something");
    expect(attestation.signedText).toBe(text);
  });

  it("answers a decision prompt with a parseable canonical decision on a legal target", async () => {
    const provider = new MockLocalProvider(FIXED_KEY);
    const { text } = await provider.complete(buildDecisionPrompt(ctx));

    const decision = parseDecision(text, ctx.decisionStub, ctx.legalTargets);
    expect(ctx.legalTargets).toContain(decision.target);
  });

  it("answers a speech prompt with free-form, non-JSON prose", async () => {
    const provider = new MockLocalProvider(FIXED_KEY);
    const { text } = await provider.complete(buildSpeechPrompt(ctx));
    expect(() => JSON.parse(text)).toThrow();
  });
});
