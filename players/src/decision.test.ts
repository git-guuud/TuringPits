import { describe, it, expect } from "vitest";
import { encodeDecision } from "@turingpits/engine";
import type { Decision } from "@turingpits/engine";
import { parseDecision } from "./decision.js";

const stub: Omit<Decision, "target"> = {
  nonce: "deadbeef",
  phase: "day",
  round: 2,
  player: 2,
  action: "vote",
};
const legal = [0, 1, 3, 4];

describe("parseDecision", () => {
  it("parses an exact canonical decision string into a Decision", () => {
    const text = encodeDecision({ ...stub, target: 3 });
    expect(parseDecision(text, stub, legal)).toEqual({ ...stub, target: 3 });
  });

  it("rejects an illegal target seat", () => {
    const text = encodeDecision({ ...stub, target: 2 }); // 2 not in legal set
    expect(() => parseDecision(text, stub, legal)).toThrow(/target/i);
  });

  it("rejects when the model altered a pinned field (e.g. the action)", () => {
    const text = encodeDecision({ ...stub, action: "kill", target: 3 });
    expect(() => parseDecision(text, stub, legal)).toThrow();
  });

  it("rejects non-canonical bytes (extra whitespace) so on-chain reconstruction matches", () => {
    const text = encodeDecision({ ...stub, target: 3 }).replace("{", "{ ");
    expect(() => parseDecision(text, stub, legal)).toThrow(/canonical/i);
  });

  it("rejects unparseable output", () => {
    expect(() => parseDecision("seat 3 obviously", stub, legal)).toThrow();
  });
});
