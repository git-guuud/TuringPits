import { describe, expect, it } from "vitest";
import { createMinIntervalThrottle, createTokenBudgetThrottle } from "./throttle.js";

/** Virtual clock: `delay` advances time synchronously so spacing is deterministic. */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    delay: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    at: () => t,
  };
}

describe("createMinIntervalThrottle", () => {
  it("does not delay the first acquisition", async () => {
    const c = virtualClock();
    const throttle = createMinIntervalThrottle(6000, c.now, c.delay);
    await throttle();
    expect(c.at()).toBe(0);
  });

  it("spaces sequential acquisitions by at least minIntervalMs", async () => {
    const c = virtualClock();
    const throttle = createMinIntervalThrottle(6000, c.now, c.delay);
    const starts: number[] = [];
    await throttle(); starts.push(c.at());
    await throttle(); starts.push(c.at());
    await throttle(); starts.push(c.at());
    expect(starts).toEqual([0, 6000, 12000]);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(6000);
    }
  });

  it("paces a concurrent burst (calls enqueued without awaiting) under the cap", async () => {
    const c = virtualClock();
    const throttle = createMinIntervalThrottle(6000, c.now, c.delay);
    await Promise.all([throttle(), throttle(), throttle(), throttle()]);
    // 4 starts spaced by 6000 → last start at 18000; ≤ 10/min holds (one per 6s).
    expect(c.at()).toBe(18000);
  });

  it("does not over-delay when real time already exceeds the interval", async () => {
    let t = 0;
    const now = () => t;
    const delay = (ms: number) => {
      t += ms;
      return Promise.resolve();
    };
    const throttle = createMinIntervalThrottle(6000, now, delay);
    await throttle(); // lastStart = 0
    t = 20000; // simulate 20s of real work elapsing between calls
    await throttle(); // wait = 6000 - 20000 < 0 → no delay
    expect(t).toBe(20000);
  });
});

describe("createTokenBudgetThrottle", () => {
  it("admits calls immediately while the rolling window stays under budget", async () => {
    const c = virtualClock();
    const throttle = createTokenBudgetThrottle(2000, 60000, c.now, c.delay);
    const starts: number[] = [];
    await throttle(500); starts.push(c.at());
    await throttle(500); starts.push(c.at());
    await throttle(500); starts.push(c.at());
    expect(starts).toEqual([0, 0, 0]); // 1500 ≤ 2000, no waiting
  });

  it("waits out the window when the next call would exceed the token budget", async () => {
    const c = virtualClock();
    const throttle = createTokenBudgetThrottle(1000, 60000, c.now, c.delay);
    const starts: number[] = [];
    await throttle(600); starts.push(c.at()); // 600 ≤ 1000 → now
    await throttle(600); starts.push(c.at()); // 1200 > 1000 → wait one window
    await throttle(600); starts.push(c.at()); // again over → wait another window
    expect(starts).toEqual([0, 60001, 120002]);
  });

  it("admits a single call larger than the whole budget once the window is empty", async () => {
    const c = virtualClock();
    const throttle = createTokenBudgetThrottle(1000, 60000, c.now, c.delay);
    await throttle(5000); // > budget, but nothing else in the window → must let it through
    expect(c.at()).toBe(0);
  });
});
