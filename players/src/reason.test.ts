import { describe, it, expect } from "vitest";
import { parseReason, parseVoteSpeech } from "./reason.js";

describe("parseReason", () => {
  it("parses a JSON {target, reason} object", () => {
    const r = parseReason('{"target": 3, "reason": "seat 3 dodged every question"}', [1, 3, 4]);
    expect(r.target).toBe(3);
    expect(r.reason).toBe("seat 3 dodged every question");
  });

  it("parses a JSON object wrapped in ```json code fences", () => {
    const r = parseReason('```json\n{"target": 4, "reason": "Esme is the early threat"}\n```', [1, 3, 4]);
    expect(r.target).toBe(4);
    expect(r.reason).toBe("Esme is the early threat");
  });

  it("never leaks raw JSON/fences into the reason on the lenient path", () => {
    // Malformed (trailing comma) so JSON.parse fails on every candidate; target 4 still recovered.
    const r = parseReason('```json\n{"target": 4, "reason": "Esme looks suspicious",}\n```', [1, 4]);
    expect(r.target).toBe(4);
    expect(r.reason).toBe("Esme looks suspicious");
    expect(r.reason).not.toContain("{");
    expect(r.reason).not.toContain("```");
    expect(r.reason).not.toMatch(/target/i);
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

describe("parseVoteSpeech", () => {
  it("parses the labelled TARGET / CASE format", () => {
    const r = parseVoteSpeech("TARGET: 3\nCASE: Boris keeps dodging — he gets my vote today.", [1, 3, 4]);
    expect(r).not.toBeNull();
    expect(r!.target).toBe(3);
    expect(r!.speech).toBe("Boris keeps dodging — he gets my vote today.");
  });

  it("is lenient about label punctuation, 'seat', and wrapping quotes/fences", () => {
    const r = parseVoteSpeech('TARGET = seat #4\nCASE: "Esme is the threat — vote her out."', [1, 4]);
    expect(r!.target).toBe(4);
    expect(r!.speech).toBe("Esme is the threat — vote her out.");
  });

  it("falls back to the first legal integer and the leftover text as the case", () => {
    // No labels at all: recover the target from a legal seat number, keep the rest as the case.
    const r = parseVoteSpeech("I'm going after seat 3 — they've dodged every question.", [1, 3]);
    expect(r!.target).toBe(3);
    expect(r!.speech).toContain("dodged every question");
  });

  it("returns a target with an empty case when only the target line is present", () => {
    const r = parseVoteSpeech("TARGET: 1", [1, 3]);
    expect(r!.target).toBe(1);
    expect(r!.speech).toBe("");
  });

  it("returns null when no legal target can be recovered (caller resamples)", () => {
    expect(parseVoteSpeech("I really cannot decide who to vote for.", [1, 3])).toBeNull();
    expect(parseVoteSpeech("TARGET: 9\nCASE: vote seat 9.", [1, 3])).toBeNull(); // 9 not legal, no other digit
  });
});
