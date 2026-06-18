import { describe, it, expect } from "vitest";
import { Player } from "./player.js";
import { MockLocalProvider } from "./provider.js";
import { verifyAttestation } from "./attestation.js";
import { toSettlementMove } from "./match.js";
import { wrapResponseBody } from "./envelope.js";
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

  it("binds the decision to the signed body (settlement move maps cleanly)", async () => {
    const player = new Player(new MockLocalProvider(FIXED_KEY));
    const turn = await player.takeTurn(ctx);
    // toSettlementMove asserts the on-chain binding (sliced body bytes == encoded decision)
    // and would throw on any mismatch; the mapped target must match the structured decision.
    const move = toSettlementMove(turn);
    expect(move.decision.target).toBe(turn.structuredDecision.target);
    expect(move.decision.action).toBe(3); // vote
  });

  it("resamples a bad decision inference up to the retry cap, then succeeds", async () => {
    let calls = 0;
    const base = new MockLocalProvider(FIXED_KEY);
    // Fails the first two DECISION inferences (illegal JSON), then defers to the real mock.
    const flaky: InferenceProvider = {
      async complete(prompt: string) {
        if (prompt.startsWith("You are seat")) {
          calls++;
          if (calls <= 2) {
            const { rawResponseBody, contentOffset, contentLen } = wrapResponseBody("not a decision");
            return {
              text: "not a decision",
              attestation: {
                signature: "0x00",
                signerAddress: "0x0000000000000000000000000000000000000000",
                source: "MOCK-local" as const,
                rawResponseBody,
                contentOffset,
                contentLen,
                reqHashHex: "00".repeat(32),
                providerType: "centralized",
                providerIdentity: "aliyun",
                tlsFingerprint: "sha256/x=",
              },
            };
          }
        }
        return base.complete(prompt);
      },
    };
    const turn = await new Player(flaky, { decisionRetries: 3 }).takeTurn(ctx);
    expect(calls).toBe(3); // two failures + one success
    expect(ctx.legalTargets).toContain(turn.structuredDecision.target);
    expect(verifyAttestation(turn.attestation)).toBe(true);
  });

  it("makes the structured decision target the seat chosen during reasoning (speech ⇆ action)", async () => {
    // respond: decision prompt → echo the pinned skeleton; reason prompt → choose seat 1; else prose.
    const respond = (prompt: string): string => {
      if (prompt.startsWith("You are seat")) {
        return prompt.split("\n").find((l) => l.trimStart().startsWith('{"nonce"'))!.trim();
      }
      if (prompt.includes("Legal target seats")) {
        return '{"target":1,"reason":"seat 1 has dodged every direct question"}';
      }
      return "Seat 1 keeps deflecting — I am going after them.";
    };
    const turn = await new Player(new MockLocalProvider(FIXED_KEY, respond)).takeTurn(ctx);

    expect(turn.structuredDecision.target).toBe(1);
    expect(turn.speech).toContain("Seat 1");
    expect(verifyAttestation(turn.attestation)).toBe(true);
  });

  it("falls back to a legal target when the reasoning inference never names one", async () => {
    const respond = (prompt: string): string => {
      if (prompt.startsWith("You are seat")) {
        return prompt.split("\n").find((l) => l.trimStart().startsWith('{"nonce"'))!.trim();
      }
      if (prompt.includes("Legal target seats")) return "I honestly cannot decide who to pick.";
      return "Hard to say, but I'll commit.";
    };
    const turn = await new Player(new MockLocalProvider(FIXED_KEY, respond)).takeTurn(ctx);

    // No legal target named → deterministic fallback to the first legal target.
    expect(turn.structuredDecision.target).toBe(ctx.legalTargets[0]);
    expect(verifyAttestation(turn.attestation)).toBe(true);
  });

  it("throws if the provider's decision output is illegal (never silently corrected)", async () => {
    const rogue: InferenceProvider = {
      async complete(prompt: string) {
        const text = prompt.startsWith("You are seat") ? '{"nonce":"x"}' : "chatter";
        const { rawResponseBody, contentOffset, contentLen } = wrapResponseBody(text);
        const att: Attestation = {
          signature: "0x00",
          signerAddress: "0x0000000000000000000000000000000000000000",
          source: "MOCK-local",
          rawResponseBody,
          contentOffset,
          contentLen,
          reqHashHex: "00".repeat(32),
          providerType: "centralized",
          providerIdentity: "aliyun",
          tlsFingerprint: "sha256/x=",
        };
        return { text, attestation: att };
      },
    };
    await expect(new Player(rogue).takeTurn(ctx)).rejects.toThrow();
  });
});
