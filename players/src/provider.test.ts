import { describe, it, expect } from "vitest";
import { verifyAttestation } from "./attestation.js";
import { parseDecision } from "./decision.js";
import { parseReason } from "./reason.js";
import { buildDecisionPrompt, buildReasonPrompt, buildSpeechPrompt } from "./prompt.js";
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

  it("carries a full envelope: the returned text sits in the signed body at content offset/len", async () => {
    const provider = new MockLocalProvider(FIXED_KEY);
    const { text, attestation } = await provider.complete("say something");

    const bodyBytes = Buffer.from(attestation.rawResponseBody.slice(2), "hex");
    const slice = bodyBytes
      .subarray(attestation.contentOffset, attestation.contentOffset + attestation.contentLen)
      .toString("utf8");
    expect(slice).toBe(text); // plain prose needs no JSON-escaping; equals verbatim
    expect(attestation.reqHashHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers a reason prompt with a JSON object naming a legal target", async () => {
    const provider = new MockLocalProvider(FIXED_KEY);
    const { text } = await provider.complete(buildReasonPrompt(ctx));

    const reason = parseReason(text, ctx.legalTargets);
    expect(ctx.legalTargets).toContain(reason.target);
  });

  it("echoes a decision prompt's pinned target back as a canonical decision", async () => {
    const provider = new MockLocalProvider(FIXED_KEY);
    const { text } = await provider.complete(buildDecisionPrompt(ctx, 3));

    const decision = parseDecision(text, ctx.decisionStub, ctx.legalTargets);
    expect(decision.target).toBe(3);
  });

  it("answers a speech prompt with free-form, non-JSON prose", async () => {
    const provider = new MockLocalProvider(FIXED_KEY);
    const { text } = await provider.complete(buildSpeechPrompt(ctx, 3, "a hunch"));
    expect(() => JSON.parse(text)).toThrow();
  });
});
