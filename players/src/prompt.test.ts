import { describe, it, expect } from "vitest";
import { buildSpeechPrompt, buildDecisionPrompt } from "./prompt.js";
import type { TurnContext } from "./types.js";

const ctx: TurnContext = {
  persona: { seat: 2, name: "Ada", blurb: "a calculating analyst" },
  role: "MAFIA",
  alive: [0, 1, 2, 3, 4],
  transcript: [
    [0, "I think seat 3 is suspicious."],
    [1, "Agreed, seat 3 was quiet."],
  ],
  decisionStub: { nonce: "deadbeef", phase: "day", round: 2, player: 2, action: "vote" },
  legalTargets: [0, 1, 3, 4],
};

describe("buildSpeechPrompt", () => {
  it("tells the player its seat, name, and secret role", () => {
    const p = buildSpeechPrompt(ctx);
    expect(p).toContain("Ada");
    expect(p).toContain("MAFIA");
    expect(p).toContain("seat 2");
  });

  it("includes the public transcript so far", () => {
    const p = buildSpeechPrompt(ctx);
    expect(p).toContain("seat 3 is suspicious");
    expect(p).toContain("seat 3 was quiet");
  });
});

describe("buildDecisionPrompt", () => {
  it("pins every fixed field so the model can only choose the target", () => {
    const p = buildDecisionPrompt(ctx);
    expect(p).toContain('"nonce":"deadbeef"');
    expect(p).toContain('"phase":"day"');
    expect(p).toContain('"round":2');
    expect(p).toContain('"player":2');
    expect(p).toContain('"action":"vote"');
  });

  it("lists the legal targets the model may choose from", () => {
    const p = buildDecisionPrompt(ctx);
    expect(p).toContain("0, 1, 3, 4");
  });

  it("instructs the model to output only the decision string (no prose)", () => {
    const p = buildDecisionPrompt(ctx).toLowerCase();
    expect(p).toContain("only");
  });
});
