import { describe, it, expect } from "vitest";
import { nextSpeaker, MAX_SPEECHES_PER_SEAT } from "./discussion.js";
import type { NextSpeakerInput } from "./discussion.js";
import type { Persona } from "./types.js";

const personas: Persona[] = [
  { seat: 0, name: "Ada", blurb: "" },
  { seat: 1, name: "Boris", blurb: "" },
  { seat: 2, name: "Cleo", blurb: "" },
  { seat: 3, name: "Dmitri", blurb: "" },
  { seat: 4, name: "Esme", blurb: "" },
];
const alive = [0, 1, 2, 3, 4];
const seed = "0x" + "11".repeat(32);
const round = 1;

/** Terse call helper: transcript + per-seat spoken counts → the next speaker. */
function pick(
  transcript: [number, string][],
  spoken: [number, number][],
  over: Partial<NextSpeakerInput> = {},
): number | null {
  return nextSpeaker({ alive, personas, transcript, spoken: new Map(spoken), seed, round, ...over });
}

describe("nextSpeaker", () => {
  it("opens with a living seat and is deterministic for a fixed seed", () => {
    const first = pick([], []);
    expect(alive).toContain(first);
    expect(pick([], [])).toBe(first); // same inputs → same speaker
  });

  it("gives right-of-reply to a named, still-unspoken seat", () => {
    // Seat 0 has spoken and calls out Cleo (seat 2); Cleo answers next.
    expect(pick([[0, "Cleo is hiding something"]], [[0, 1]])).toBe(2);
  });

  it("never picks the last speaker to reply to its own line", () => {
    // Seat 0's line names itself (Ada) and Boris; the reply goes to Boris, not back to seat 0.
    expect(pick([[0, "Ada thinks Boris is lying"]], [[0, 1]])).toBe(1);
  });

  it("excludes dead seats from replies and falls through to the living floor", () => {
    // Cleo (seat 2) is dead; naming her cannot pull her back in.
    const s = pick([[0, "Cleo is suspicious"]], [[0, 1]], { alive: [0, 1, 3, 4] });
    expect(s).not.toBe(2);
    expect([1, 3, 4]).toContain(s);
  });

  it("seats every voice once before anyone gets a second turn", () => {
    // Four of five have spoken; the last line names an already-spoken seat, but the one seat that has
    // NOT spoken (seat 4) still takes the floor first — fill beats a rebuttal.
    expect(pick([[0, "Boris is the mafia"]], [[0, 1], [1, 1], [2, 1], [3, 1]])).toBe(4);
  });

  it("allows a rebuttal only once everyone has spoken (A→B→A)", () => {
    // All five spoke once; the last line names Boris (seat 1), under the per-seat cap → he answers back.
    expect(pick([[0, "Boris is the mafia"]], [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]])).toBe(1);
  });

  it("closes the floor when all have spoken and the last line names no one", () => {
    expect(pick([[0, "we should all stay calm"]], [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]])).toBeNull();
  });

  it("closes the floor when every eligible seat has hit the per-seat cap", () => {
    const capped = alive.map((s) => [s, MAX_SPEECHES_PER_SEAT] as [number, number]);
    expect(pick([[0, "Boris lies again"]], capped)).toBeNull();
  });

  it("matches names as whole words, case-insensitively, ignoring punctuation and substrings", () => {
    // Lower-case + trailing punctuation still matches: "boris," pulls Boris (seat 1).
    expect(pick([[0, "I don't trust boris, honestly."]], [[0, 1]])).toBe(1);
    // "adamant" must NOT match "Ada". With everyone already spoken, a false substring match would
    // trigger a rebuttal from seat 0; a correct whole-word match finds no one, so the floor closes.
    const allSpoke: [number, number][] = [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]];
    expect(pick([[1, "I am adamant about this"]], allSpoke)).toBeNull();
  });

  it("reshuffles the opening order across rounds (not always the lowest seat)", () => {
    // A fixed seed still varies which seat opens as the round number changes.
    const openers = new Set(
      Array.from({ length: 6 }, (_, r) => pick([], [], { round: r + 1 })),
    );
    expect(openers.size).toBeGreaterThan(1);
  });
});
