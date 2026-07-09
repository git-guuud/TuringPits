/**
 * createProviderCache — one provider bundle reused across rounds. The cache must: build lazily,
 * serve the cached bundle while it revalidates, rebuild on rotation/revalidation failure, treat a
 * mock bundle (no revalidate) as always valid, and drop everything on invalidate().
 */
import { describe, expect, it, vi } from "vitest";
import { createProviderCache, type ProviderBundle } from "./match-runner.js";

function bundle(overrides: Partial<ProviderBundle> = {}): ProviderBundle {
  return {
    provider: { complete: async () => ({ text: "", attestation: {} as never }) },
    isMock: false,
    teeSigner: "0x" + "11".repeat(20),
    providerMeta: { providerType: "t", providerIdentity: "i", tlsFingerprint: "f" },
    ...overrides,
  };
}

describe("createProviderCache", () => {
  it("builds once and serves the cached bundle while revalidation passes", async () => {
    const build = vi.fn(async () => bundle({ revalidate: async () => true }));
    const cache = createProviderCache(build);
    const first = await cache.get();
    const second = await cache.get();
    expect(second).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("never re-checks a mock bundle (no revalidate) — a local key cannot rotate", async () => {
    const build = vi.fn(async () => bundle({ isMock: true }));
    const cache = createProviderCache(build);
    await cache.get();
    await cache.get();
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when the TEE signer rotated (revalidate returns false)", async () => {
    let rotated = false;
    const build = vi.fn(async () => bundle({ revalidate: async () => !rotated }));
    const cache = createProviderCache(build);
    const first = await cache.get();
    rotated = true;
    const second = await cache.get();
    expect(second).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when revalidation itself throws (never serves a bundle it cannot vouch for)", async () => {
    const build = vi.fn(async () =>
      bundle({
        revalidate: async () => {
          throw new Error("rpc down");
        },
      }),
    );
    const cache = createProviderCache(build);
    await cache.get();
    await cache.get();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("invalidate() drops the cache so the next get() rebuilds", async () => {
    const build = vi.fn(async () => bundle({ isMock: true }));
    const cache = createProviderCache(build);
    await cache.get();
    cache.invalidate();
    await cache.get();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("propagates a build failure and stays empty (the next get() retries the build)", async () => {
    let fail = true;
    const build = vi.fn(async () => {
      if (fail) throw new Error("provider setup failed");
      return bundle({ isMock: true });
    });
    const cache = createProviderCache(build);
    await expect(cache.get()).rejects.toThrow("provider setup failed");
    fail = false;
    await expect(cache.get()).resolves.toBeTruthy();
    expect(build).toHaveBeenCalledTimes(2);
  });
});
