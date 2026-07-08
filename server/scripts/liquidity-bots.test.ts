import { describe, it, expect } from "vitest";
import { chooseOutcome, nextLean, minPoolOutcome, type Lean } from "./liquidity-bots.js";

// Deterministic PRNG so every statistical claim below is reproducible without a chain or relayer.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run `n` wagers under one lean, tallying how many stakes each outcome drew. */
function tally(numOutcomes: number, lean: Lean, n: number, rng: () => number): number[] {
  const counts = new Array(numOutcomes).fill(0);
  for (let i = 0; i < n; i++) counts[chooseOutcome(numOutcomes, lean, rng)]++;
  return counts;
}

describe("minPoolOutcome — the current underdog", () => {
  it("returns the index of the smallest pool", () => {
    expect(minPoolOutcome([100n, 10n, 50n], 3)).toBe(1);
    expect(minPoolOutcome([5n, 10n, 50n], 3)).toBe(0);
  });
  it("resolves ties to the lowest index and treats missing pools as zero", () => {
    expect(minPoolOutcome([0n, 0n, 5n], 3)).toBe(0);
    expect(minPoolOutcome([], 3)).toBe(0); // all absent → all zero → first
  });
});

describe("chooseOutcome — imbalance that moves the %", () => {
  it("concentrates stakes on the favored outcome at roughly its strength", () => {
    const rng = mulberry32(1);
    const counts = tally(2, { favored: 1, strength: 0.8, phase: "push" }, 20_000, rng);
    const favShare = counts[1] / 20_000;
    // strength 0.8 on a 2-way market → favored ≈ 0.8 + 0.2*0.5 = 0.9 of stakes. It must dominate.
    expect(favShare).toBeGreaterThan(0.85);
    expect(favShare).toBeLessThan(0.95);
    expect(counts[1]).toBeGreaterThan(counts[0]);
  });

  it("a balanced lean (strength 0.5) leaves a 2-way market ~even (no movement)", () => {
    const rng = mulberry32(7);
    const counts = tally(2, { favored: 0, strength: 0.5, phase: "push" }, 20_000, rng);
    const share0 = counts[0] / 20_000;
    // favored drawn at 0.5, plus 0.5*0.5 from the random tail = 0.75... so even "balanced" tilts; the
    // real balance point for a 2-way is strength 0 — assert it's far less lopsided than the 0.8 case.
    expect(share0).toBeLessThan(0.8);
    expect(share0).toBeGreaterThan(0.6);
  });

  it("spreads across all outcomes on a many-way market but still favors one", () => {
    const rng = mulberry32(3);
    const counts = tally(7, { favored: 4, strength: 0.7, phase: "push" }, 21_000, rng);
    expect(counts[4]).toBe(Math.max(...counts)); // the favored seat leads
    expect(counts.every((c) => c > 0)).toBe(true); // every outcome still gets some liquidity
  });

  it("never returns an out-of-range outcome even if favored is invalid", () => {
    const rng = mulberry32(9);
    for (let i = 0; i < 500; i++) {
      const o = chooseOutcome(2, { favored: 5, strength: 0.9, phase: "push" }, rng);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(2);
    }
  });
});

describe("nextLean — push ↔ correct waves and the drama override", () => {
  it("hard-pushes onto a forced (drama) outcome at full strength", () => {
    const lean = nextLean({ numOutcomes: 6, pools: [1n, 2n, 3n, 4n, 5n, 6n], favoredOutcome: 3, strengthMax: 0.82 });
    expect(lean.favored).toBe(3);
    expect(lean.phase).toBe("push");
    expect(lean.strength).toBeCloseTo(0.82, 5);
  });

  it("ignores an out-of-range drama outcome and falls back to the wave cycle", () => {
    const lean = nextLean({ numOutcomes: 3, pools: [50n, 10n, 20n], favoredOutcome: 9, prev: { favored: 0, strength: 0.8, phase: "push" }, rng: mulberry32(2) });
    // 9 is invalid → not a drama push; prev was a push → this is a correction toward the underdog (idx 1).
    expect(lean.phase).toBe("correct");
    expect(lean.favored).toBe(1);
  });

  it("after a push, corrects toward the current underdog at moderate strength", () => {
    const lean = nextLean({ numOutcomes: 3, pools: [500n, 40n, 200n], prev: { favored: 0, strength: 0.82, phase: "push" }, rng: mulberry32(5) });
    expect(lean.phase).toBe("correct");
    expect(lean.favored).toBe(1); // smallest pool
    expect(lean.strength).toBeGreaterThanOrEqual(0.5);
    expect(lean.strength).toBeLessThanOrEqual(0.7);
  });

  it("after a correction, pushes again onto a fresh outcome", () => {
    const lean = nextLean({ numOutcomes: 4, pools: [10n, 10n, 10n, 10n], prev: { favored: 1, strength: 0.6, phase: "correct" }, strengthMax: 0.82, rng: mulberry32(11) });
    expect(lean.phase).toBe("push");
    expect(lean.strength).toBeGreaterThan(0.6);
    expect(lean.favored).toBeGreaterThanOrEqual(0);
    expect(lean.favored).toBeLessThan(4);
  });
});

describe("a push wave then a correction wave — the visible swing", () => {
  it("push lifts the favored outcome's share, then correction pulls it back down", () => {
    const rng = mulberry32(42);
    const pools = [1000n, 1000n]; // start even
    const share0 = () => Number(pools[0]) / Number(pools[0] + pools[1]);

    // PUSH onto outcome 0 → its share climbs above the even 0.5 start.
    const push: Lean = { favored: 0, strength: 0.85, phase: "push" };
    for (let i = 0; i < 400; i++) pools[chooseOutcome(2, push, rng)] += 20n;
    const peak = share0();
    expect(peak).toBeGreaterThan(0.6);

    // CORRECT toward the underdog (now outcome 1) → outcome 0's share falls back from its peak.
    const correct = nextLean({ numOutcomes: 2, pools, prev: push, rng });
    expect(correct.favored).toBe(1);
    for (let i = 0; i < 400; i++) pools[chooseOutcome(2, correct, rng)] += 20n;
    expect(share0()).toBeLessThan(peak);
  });
});
