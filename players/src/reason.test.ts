import { describe, it, expect } from "vitest";
import { parseReason } from "./reason.js";

describe("parseReason", () => {
  it("parses a JSON {target, reason} object", () => {
    const r = parseReason('{"target": 3, "reason": "seat 3 dodged every question"}', [1, 3, 4]);
    expect(r.target).toBe(3);
    expect(r.reason).toBe("seat 3 dodged every question");
  });

  it("extracts the first legal integer from prose when the output is not JSON", () => {
    const r = parseReason("My read is that seat 3 is the mafia, voting them.", [1, 3]);
    expect(r.target).toBe(3);
    expect(r.reason).toContain("seat 3");
  });

  it("ignores an illegal JSON target and throws when nothing legal appears", () => {
    expect(() => parseReason('{"target": 9, "reason": "x"}', [1, 3])).toThrow();
  });

  it("throws when no legal target is named at all", () => {
    expect(() => parseReason("I have no idea who to pick.", [1, 3])).toThrow();
  });
});
