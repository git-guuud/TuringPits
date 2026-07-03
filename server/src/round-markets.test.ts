import { describe, it, expect } from "vitest";
import { nightKillResolved, votedOutResolved, type RoundPhase } from "./round-markets.js";

const st = (round: number, phase: "night" | "day", winner: unknown = null): RoundPhase => ({ round, phase, winner });

describe("round-markets — night-kill freeze timing (freezes at dawn)", () => {
  it("stays OPEN while round R's night is still resolving (phase == night)", () => {
    expect(nightKillResolved(st(1, "night"), 1)).toBe(false);
    expect(nightKillResolved(st(3, "night"), 3)).toBe(false);
  });

  it("resolves at DAWN of its own round (phase flips to day, round unchanged)", () => {
    expect(nightKillResolved(st(1, "day"), 1)).toBe(true);
    expect(nightKillResolved(st(2, "day"), 2)).toBe(true);
  });

  it("is resolved for any earlier round (the match has moved on)", () => {
    expect(nightKillResolved(st(3, "night"), 1)).toBe(true);
    expect(nightKillResolved(st(3, "night"), 2)).toBe(true);
  });

  it("is NOT yet resolved for a future round's night (never freeze ahead of play)", () => {
    expect(nightKillResolved(st(1, "day"), 2)).toBe(false);
    expect(nightKillResolved(st(2, "night"), 3)).toBe(false);
  });

  it("is resolved for every opened round once the match is over (even mid-night)", () => {
    expect(nightKillResolved(st(2, "night", "MAFIA"), 2)).toBe(true);
    expect(nightKillResolved(st(2, "night", "TOWN"), 3)).toBe(true);
  });

  it("freezes exactly once across a round's life (night open → dawn closes → stays closed)", () => {
    // Round 2's night-kill market: open through night 2, closes at dawn 2, and stays closed after.
    expect(nightKillResolved(st(2, "night"), 2)).toBe(false); // night 2 in progress
    expect(nightKillResolved(st(2, "day"), 2)).toBe(true); // dawn 2 → freeze
    expect(nightKillResolved(st(3, "night"), 2)).toBe(true); // round 3 → still frozen
  });
});

describe("round-markets — voted-out freeze timing (freezes after the day vote)", () => {
  it("stays OPEN through its own round's night AND day (the vote is still live)", () => {
    expect(votedOutResolved(st(1, "night"), 1)).toBe(false);
    expect(votedOutResolved(st(1, "day"), 1)).toBe(false); // day 1 vote still open
    expect(votedOutResolved(st(2, "day"), 2)).toBe(false);
  });

  it("resolves only once the match advances PAST the round (the vote is in)", () => {
    expect(votedOutResolved(st(2, "night"), 1)).toBe(true);
    expect(votedOutResolved(st(3, "day"), 2)).toBe(true);
  });

  it("is resolved for every opened round once the match is over", () => {
    expect(votedOutResolved(st(2, "day", "MAFIA"), 2)).toBe(true);
  });

  it("night-kill closes a full phase BEFORE voted-out within the same round", () => {
    // At dawn of round 2 (phase == day, round == 2): night-kill 2 is frozen, voted-out 2 still open.
    const dawn2 = st(2, "day");
    expect(nightKillResolved(dawn2, 2)).toBe(true);
    expect(votedOutResolved(dawn2, 2)).toBe(false);
  });
});
