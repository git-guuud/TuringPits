/**
 * ZeroGDirectProvider.signerUnchanged — the cheap revalidation a cross-round provider cache runs
 * instead of a full rebuild (broker setup + paid probe inference). It must answer with ONE chain
 * read: "does the provider's registered TEE signer still equal the one probed at setup?"
 */
import { describe, expect, it } from "vitest";
import { ZeroGDirectProvider } from "./zerog.js";

const SIGNER = "0xD45B0000000000000000000000000000000017d4";

function providerWith(statusSigner: unknown): ZeroGDirectProvider {
  const broker = {
    inference: {
      checkProviderSignerStatus: async () => ({ isAcknowledged: true, teeSignerAddress: statusSigner }),
    },
  };
  return new ZeroGDirectProvider(broker, "0xprovider", "https://svc.example", "test-model", SIGNER);
}

describe("signerUnchanged", () => {
  it("is true while the registered TEE signer matches the probed one (case-insensitive)", async () => {
    await expect(providerWith(SIGNER).signerUnchanged()).resolves.toBe(true);
    await expect(providerWith(SIGNER.toLowerCase()).signerUnchanged()).resolves.toBe(true);
  });

  it("is false once the provider rotates its signer (a stale registration would brick settle)", async () => {
    await expect(providerWith("0x" + "ab".repeat(20)).signerUnchanged()).resolves.toBe(false);
  });

  it("is false (not a throw) on a missing/undefined status signer", async () => {
    await expect(providerWith(undefined).signerUnchanged()).resolves.toBe(false);
  });

  it("propagates a failed status read so the caller's retry/rebuild policy decides", async () => {
    const broker = {
      inference: {
        checkProviderSignerStatus: async () => {
          throw new Error("rpc down");
        },
      },
    };
    const p = new ZeroGDirectProvider(broker, "0xprovider", "https://svc.example", "test-model", SIGNER);
    await expect(p.signerUnchanged()).rejects.toThrow("rpc down");
  });
});
