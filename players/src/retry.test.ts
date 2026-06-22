import { describe, expect, it, vi } from "vitest";
import { isTransientError, withRetry } from "./retry.js";

const noDelay = () => Promise.resolve();

describe("isTransientError", () => {
  it("treats network/transport errors as transient", () => {
    expect(isTransientError({ code: "TIMEOUT" })).toBe(true);
    expect(isTransientError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isTransientError({ code: "ENETUNREACH" })).toBe(true);
    expect(isTransientError(new Error("request timeout"))).toBe(true);
    expect(isTransientError(new Error("0G Compute inference failed: 429 rate limit"))).toBe(true);
    expect(isTransientError(new Error("502 Bad Gateway"))).toBe(true);
  });

  it("treats contract reverts and bad requests as permanent", () => {
    expect(isTransientError({ code: "CALL_EXCEPTION", message: 'execution reverted: "deadline passed"' })).toBe(false);
    expect(isTransientError(new Error('execution reverted: "deadline passed"'))).toBe(false);
    expect(isTransientError(new Error("400 'seed' must be Integer"))).toBe(false);
  });

  it("unwraps AggregateError (happy-eyeballs) and is transient if any inner is", () => {
    const agg = Object.assign(new Error("agg"), {
      errors: [{ code: "ENETUNREACH" }, { code: "ETIMEDOUT" }],
    });
    expect(isTransientError(agg)).toBe(true);
  });
});

describe("withRetry", () => {
  it("returns immediately on success without delay", async () => {
    const fn = vi.fn(async () => 42);
    expect(await withRetry(fn, { delay: noDelay })).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw { code: "TIMEOUT" };
      return "ok";
    });
    const delays: number[] = [];
    const result = await withRetry(fn, { delay: (ms) => { delays.push(ms); return Promise.resolve(); } });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([500, 1000]); // exponential backoff
  });

  it("does not retry permanent errors (reverts) — fails fast", async () => {
    const fn = vi.fn(async () => { throw new Error('execution reverted: "deadline passed"'); });
    await expect(withRetry(fn, { delay: noDelay })).rejects.toThrow("deadline passed");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after `retries` attempts and throws the last error", async () => {
    const fn = vi.fn(async () => { throw { code: "ETIMEDOUT", message: "nope" }; });
    await expect(withRetry(fn, { retries: 2, delay: noDelay })).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it("caps backoff at maxDelayMs", async () => {
    let calls = 0;
    const delays: number[] = [];
    const fn = vi.fn(async () => { calls++; if (calls < 5) throw { code: "TIMEOUT" }; return 1; });
    await withRetry(fn, { baseDelayMs: 1000, maxDelayMs: 3000, delay: (ms) => { delays.push(ms); return Promise.resolve(); } });
    expect(delays).toEqual([1000, 2000, 3000, 3000]); // capped
  });
});
