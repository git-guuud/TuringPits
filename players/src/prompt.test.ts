import { describe, it, expect } from "vitest";
import { buildReasonPrompt, buildSpeechPrompt, buildDecisionPrompt } from "./prompt.js";
import type { TurnContext } from "./types.js";

const base: TurnContext = {
  persona: { seat: 2, name: "Ada", blurb: "a calculating analyst" },
  role: "TOWN",
  alive: [0, 1, 2, 3, 4],
  transcript: [
    [0, "I think seat 3 is suspicious."],
    [1, "Agreed, seat 3 was quiet."],
  ],
  decisionStub: { nonce: "deadbeef", phase: "day", round: 2, player: 2, action: "vote" },
  legalTargets: [0, 1, 3, 4],
};

const mafiaCtx: TurnContext = { ...base, role: "MAFIA", teammates: [4] };
const detectiveCtx: TurnContext = {
  ...base,
  role: "DETECTIVE",
  investigations: [{ round: 1, target: 1, faction: "MAFIA" }],
};

describe("buildReasonPrompt", () => {
  it("includes the public transcript and the legal targets", () => {
    const p = buildReasonPrompt(base);
    expect(p).toContain("seat 3 is suspicious");
    expect(p).toContain("0, 1, 3, 4");
  });

  it("asks for a JSON target+reason object", () => {
    const p = buildReasonPrompt(base).toLowerCase();
    expect(p).toContain('"target"');
    expect(p).toContain('"reason"');
  });

  it("gives MAFIA its teammates and a license to deceive", () => {
    const p = buildReasonPrompt(mafiaCtx);
    expect(p).toContain("4"); // teammate seat
    expect(p.toLowerCase()).toContain("lie");
  });

  it("does NOT give a town role any 'cover' / deception framing", () => {
    const p = buildReasonPrompt(base).toLowerCase();
    expect(p).not.toContain("cover");
    expect(p).not.toContain("lie");
  });

  it("gives DETECTIVE its own investigation results with the revealed alignment", () => {
    const p = buildReasonPrompt(detectiveCtx);
    expect(p).toContain("seat 1");
    expect(p).toContain("MAFIA");
  });
});

describe("buildSpeechPrompt", () => {
  it("tells the player its seat, name, and secret role", () => {
    const p = buildSpeechPrompt(base, 3, "seat 3 keeps dodging");
    expect(p).toContain("Ada");
    expect(p).toContain("TOWN");
    expect(p).toContain("seat 2");
  });

  it("narrates the actual chosen target and the private reason", () => {
    const p = buildSpeechPrompt(base, 3, "seat 3 keeps dodging");
    expect(p).toContain("seat 3");
    expect(p).toContain("seat 3 keeps dodging");
  });

  it("forbids parroting other players and self-accusation", () => {
    const p = buildSpeechPrompt(base, 3, "x").toLowerCase();
    expect(p).toContain("repeat");
    expect(p).toContain("yourself");
  });
});

describe("buildDecisionPrompt", () => {
  it("pins every fixed field and the chosen target into the skeleton", () => {
    const p = buildDecisionPrompt(base, 3);
    expect(p).toContain('"nonce":"deadbeef"');
    expect(p).toContain('"action":"vote"');
    expect(p).toContain('"target":3');
  });

  it("instructs the model to output only the decision string (no prose)", () => {
    const p = buildDecisionPrompt(base, 3).toLowerCase();
    expect(p).toContain("only");
  });
});
