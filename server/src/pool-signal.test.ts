import { describe, it, expect, vi } from "vitest";
import { createPoolSignal } from "./pool-signal.js";

describe("pool-signal — bet-driven pool pushes", () => {
  it("bumps the active match's pusher", () => {
    const s = createPoolSignal();
    const push = vi.fn();
    s.register(1, push);
    s.bump(1);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("ignores a bump for a different match than the active one", () => {
    const s = createPoolSignal();
    const push = vi.fn();
    s.register(1, push);
    s.bump(2); // a late relay from a finished match
    expect(push).not.toHaveBeenCalled();
  });

  it("stops pushing after unregister (so a late bump can't fire after settle)", () => {
    const s = createPoolSignal();
    const push = vi.fn();
    const off = s.register(1, push);
    off();
    s.bump(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("re-registration takes over — the old match's pusher no longer fires", () => {
    const s = createPoolSignal();
    const a = vi.fn();
    const b = vi.fn();
    s.register(1, a);
    s.register(2, b); // next match starts
    s.bump(1);
    s.bump(2);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unregistering the old match does not clear a newer registration", () => {
    const s = createPoolSignal();
    const a = vi.fn();
    const b = vi.fn();
    const offA = s.register(1, a);
    s.register(2, b);
    offA(); // match 1 tears down after match 2 already took over
    s.bump(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("no active registration → bump is a harmless no-op", () => {
    const s = createPoolSignal();
    expect(() => s.bump(1)).not.toThrow();
  });
});
