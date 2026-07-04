import { describe, it, expect } from "vitest";
import { runBetWindow, type BetWindowDeps } from "./bet-windows.js";
import type { WsMessage } from "./wire.js";

/** A recording harness with a controllable clock and instant sleeps, so timing is deterministic. */
function harness(opts: { now?: number; freezeReturns?: boolean } = {}) {
  const broadcasts: WsMessage[] = [];
  const sleeps: number[] = [];
  const freezes: { propIdx: number; label: string }[] = [];
  let pushCount = 0;
  const deps: BetWindowDeps = {
    broadcast: (m) => broadcasts.push(m),
    pushPools: async () => { pushCount++; },
    freeze: async (propIdx, label) => { freezes.push({ propIdx, label }); return opts.freezeReturns ?? true; },
    sleep: async (ms) => { sleeps.push(ms); }, // instant — the clock does not advance
    now: () => opts.now ?? 1_000_000,
  };
  return { deps, broadcasts, sleeps, freezes, get pushCount() { return pushCount; } };
}

describe("runBetWindow", () => {
  it("emits a bet_window beat with endsAt = now + duration and the market/round/prop/seat fields", async () => {
    const h = harness({ now: 1_000_000 });
    await runBetWindow(h.deps, {
      market: "DETECTIVE_CLAIM", round: 2, propIndex: 7, durationMs: 30_000, freezeOnClose: false, seat: 3, freeAt: 0,
    });
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]).toEqual({
      type: "bet_window", market: "DETECTIVE_CLAIM", round: 2, propIndex: 7, endsAt: 1_030_000, durationMs: 30_000, seat: 3,
    });
  });

  it("holds for the full duration (sleeps durationMs) between opening and closing", async () => {
    const h = harness({ now: 5_000 });
    await runBetWindow(h.deps, {
      market: "NIGHT_KILL", round: 1, propIndex: 4, durationMs: 30_000, freezeOnClose: true, freeAt: 0, // freeAt<now → no pre-wait
    });
    // freeAt (0) is already in the past, so the only sleep is the window hold itself.
    expect(h.sleeps).toEqual([30_000]);
  });

  it("waits out the previous beat (freeAt) BEFORE opening the window", async () => {
    const h = harness({ now: 5_000 });
    await runBetWindow(h.deps, {
      market: "ROUND_VOTED_OUT", round: 1, propIndex: 6, durationMs: 60_000, freezeOnClose: true, freeAt: 12_000, // 7s left on prior beat
    });
    // First sleep drains the leftover prior-beat playback, then the window holds for its full duration.
    expect(h.sleeps).toEqual([7_000, 60_000]);
  });

  it("freezes the prop on close (round markets) and pushes pools before + after", async () => {
    const h = harness();
    await runBetWindow(h.deps, {
      market: "ROUND_VOTED_OUT", round: 3, propIndex: 9, durationMs: 60_000, freezeOnClose: true, freeAt: 0,
    });
    expect(h.freezes).toEqual([{ propIdx: 9, label: "round_voted_out:r3" }]);
    expect(h.pushCount).toBe(2); // once when the window opens, once after the freeze
  });

  it("does NOT freeze when freezeOnClose is false (the claim market stays open to settle)", async () => {
    const h = harness();
    await runBetWindow(h.deps, {
      market: "DETECTIVE_CLAIM", round: 1, propIndex: 5, durationMs: 30_000, freezeOnClose: false, seat: 2, freeAt: 0,
    });
    expect(h.freezes).toEqual([]);
    expect(h.pushCount).toBe(1); // only the open push; no freeze push
  });

  it("skips a freeze push when the prop was already frozen (freeze returns false)", async () => {
    const h = harness({ freezeReturns: false });
    await runBetWindow(h.deps, {
      market: "NIGHT_KILL", round: 2, propIndex: 8, durationMs: 30_000, freezeOnClose: true, freeAt: 0,
    });
    expect(h.freezes).toHaveLength(1); // it still ATTEMPTS the freeze (idempotent)
    expect(h.pushCount).toBe(1); // but no second push, since nothing changed
  });

  it("is a no-op for a disabled window (durationMs <= 0): no beat, no sleep, freeAt unchanged", async () => {
    const h = harness();
    const nextFreeAt = await runBetWindow(h.deps, {
      market: "NIGHT_KILL", round: 1, propIndex: 4, durationMs: 0, freezeOnClose: true, freeAt: 4242,
    });
    expect(h.broadcasts).toEqual([]);
    expect(h.sleeps).toEqual([]);
    expect(h.freezes).toEqual([]);
    expect(h.pushCount).toBe(0);
    expect(nextFreeAt).toBe(4242); // pacing cursor untouched
  });

  it("returns the updated pacing cursor (freeAt = now at close)", async () => {
    const h = harness({ now: 777_000 });
    const nextFreeAt = await runBetWindow(h.deps, {
      market: "ROUND_VOTED_OUT", round: 1, propIndex: 6, durationMs: 60_000, freezeOnClose: true, freeAt: 0,
    });
    expect(nextFreeAt).toBe(777_000);
  });
});
