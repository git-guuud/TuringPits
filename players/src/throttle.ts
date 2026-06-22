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
