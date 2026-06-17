import { describe, it, expect } from "vitest";
import { encodeDecision } from "./encoding.js";
import type { Decision } from "./types.js";

const d: Decision = {
  nonce: "abc123",
  phase: "day",
  round: 1,
  player: 2,
  action: "vote",
  target: 3,
};

describe("encodeDecision", () => {
  it("emits canonical JSON with fixed key order and no whitespace", () => {
    expect(encodeDecision(d)).toBe(
      '{"nonce":"abc123","phase":"day","round":1,"player":2,"action":"vote","target":3}',
    );
  });

  it("key order is independent of the object's property insertion order", () => {
    const reordered: Decision = {
      target: 3,
      action: "vote",
      player: 2,
      round: 1,
      phase: "day",
      nonce: "abc123",
    };
    expect(encodeDecision(reordered)).toBe(encodeDecision(d));
  });

  it("is injective across the fields that distinguish decisions", () => {
    const seen = new Set<string>();
    for (const round of [1, 2]) {
      for (const player of [0, 1]) {
        for (const target of [0, 1]) {
          seen.add(encodeDecision({ ...d, round, player, target }));
        }
      }
    }
    expect(seen.size).toBe(8);
  });
});
