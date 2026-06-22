/**
 * Minimum-interval throttle. The live 0G Compute provider enforces a per-key rate limit
 * (testnet: 10 requests/min on `/chat/completions`), but a Mafia match fires many inferences
 * back-to-back (speech + decision, per seat, per phase). This serializes calls through a
 * promise chain and spaces their *starts* by at least `minIntervalMs`, so a burst is paced out
 * to stay under the cap instead of tripping a 429.
 *
 * `now`/`delay` are injectable so the spacing logic is unit-testable with a virtual clock.
 */
export type Throttle = () => Promise<void>;

export function createMinIntervalThrottle(
  minIntervalMs: number,
  now: () => number = Date.now,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Throttle {
  let chain: Promise<void> = Promise.resolve();
  let lastStart = -Infinity;
  return () => {
    const run = chain.then(async () => {
      const wait = minIntervalMs - (now() - lastStart);
      if (wait > 0) await delay(wait);
      lastStart = now();
    });
    // Keep the chain alive even if a caller's slot rejects (it can't, but be defensive).
    chain = run.catch(() => {});
    return run;
  };
}

/** A token-aware throttle: pass the estimated token cost of the upcoming call; it resolves once
 *  admitting that many tokens keeps the rolling window under budget. */
export type TokenThrottle = (estimatedTokens: number) => Promise<void>;

/**
 * Token-budget throttle — OPT-IN, and unused by default. We once believed the 0G testnet enforced
 * a 2000 tokens/min cap on top of its 10 req/min limit, but a live rate probe
 * (`players/scripts/rate-probe.mjs`) disproved it: ~2654 tokens/min flowed with no token error, and
 * the only 429 is request-count ("limit: 10 requests/min"). So this is no longer wired into the
 * default provider path (it had imposed an artificial ~2-calls/min ceiling); it remains here as a
 * tested, ready safety valve should a real token cap ever appear — pass `tokensPerMin` to engage it.
 *
 * This keeps a rolling `windowMs` ledger of admitted token estimates and, before each call,
 * waits until enough of the oldest entries age out of the window for the new call's estimate to
 * fit under `tokensPerMin`. Calls are serialized through a promise chain (like the interval
 * throttle) so a concurrent burst is paced, not raced. A single call larger than the whole
 * budget is admitted once the window is otherwise empty (we cannot do better than one-at-a-time).
 * `now`/`delay` are injectable for a virtual-clock unit test.
 */
export function createTokenBudgetThrottle(
  tokensPerMin: number,
  windowMs = 60_000,
  now: () => number = Date.now,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): TokenThrottle {
  let chain: Promise<void> = Promise.resolve();
  const ledger: { at: number; tokens: number }[] = [];
  const usedInWindow = (): number => {
    const cutoff = now() - windowMs;
    while (ledger.length > 0 && ledger[0]!.at <= cutoff) ledger.shift();
    return ledger.reduce((s, e) => s + e.tokens, 0);
  };
  return (estimatedTokens: number) => {
    const cost = Math.max(0, estimatedTokens);
    const run = chain.then(async () => {
      // Wait until this call's tokens fit under the cap, or the window is empty (can't wait less).
      while (ledger.length > 0 && usedInWindow() + cost > tokensPerMin) {
        const wait = ledger[0]!.at + windowMs - now() + 1;
        await delay(wait > 0 ? wait : 1);
      }
      ledger.push({ at: now(), tokens: cost });
    });
    chain = run.catch(() => {});
    return run;
  };
}
