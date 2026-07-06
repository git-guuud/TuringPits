import { describe, it, expect } from "vitest";
import { classifyDetectiveClaim } from "./detective-claim.js";

const seats = (...s: number[]) => new Set<number>(s);

describe("detective-claim — one claim per match staging", () => {
  it("a non-claim discussion turn is never a claim scene", () => {
    expect(classifyDetectiveClaim(seats(), false, 0, false)).toEqual({ claim: false, counter: false, showWindow: false });
    expect(classifyDetectiveClaim(seats(2), true, 3, false)).toEqual({ claim: false, counter: false, showWindow: false });
  });

  it("the FIRST public claim opens a claim scene + fires the window (not a counter)", () => {
    expect(classifyDetectiveClaim(seats(), false, 2, true)).toEqual({ claim: true, counter: false, showWindow: true });
  });

  it("the SAME seat re-claiming in a later round is NOT a new event (streams as discussion)", () => {
    // The reported bug: a Mafia bluffing the Detective two rounds running. Seat 2 already claimed →
    // the repeat is not a claim scene, opens nothing, and never re-shows the window.
    expect(classifyDetectiveClaim(seats(2), true, 2, true)).toEqual({ claim: false, counter: false, showWindow: false });
  });

  it("a DIFFERENT seat claiming after the first is a counter — but does NOT reopen the window", () => {
    // Seat 5 counter-claims seat 2's standing claim: a fork on the SAME open pool, no re-spotlight.
    expect(classifyDetectiveClaim(seats(2), true, 5, true)).toEqual({ claim: true, counter: true, showWindow: false });
  });

  it("retries the window on a genuinely new claimant if the first never showed it (prop was missing)", () => {
    // First claimant recorded but windowShown still false (its prop read came back empty) → a new
    // claimant may still fire the once-only spotlight.
    expect(classifyDetectiveClaim(seats(2), false, 5, true)).toEqual({ claim: true, counter: true, showWindow: true });
  });

  it("once the window has shown, no later claimant reopens it", () => {
    expect(classifyDetectiveClaim(seats(2, 5), true, 6, true)).toEqual({ claim: true, counter: true, showWindow: false });
  });
});
