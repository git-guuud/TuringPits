/**
 * LIVE integration against 0G Compute (Galileo testnet) — proves the real
 * `ZeroGDirectProvider` path end to end, not just a one-off script.
 *
 * Skipped by default so the offline suite needs no network or funds. Run it explicitly with
 * real credentials loaded (see `.env`):
 *
 *   RUN_LIVE_COMPUTE=1 node --env-file=.env \
 *     node_modules/.bin/vitest run players/src/live.test.ts
 *
 * It creates the broker (funds a ledger / acknowledges the signer if needed), runs one real
 * TEE inference, and asserts the returned attestation is a `"0g-tee"` envelope that
 * `verifyAttestation` accepts, that it recovers the provider's registered `teeSignerAddress`,
 * and that the located content slice equals the model's response text. Requires a funded
 * `COMPUTE_PRIVATE_KEY` (~3 0G ledger floor + per-inference fee).
 */
import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { verifyAttestation } from "./attestation.js";
import { createZeroGDirectProvider } from "./zerog.js";

const RUN = process.env.RUN_LIVE_COMPUTE === "1";

describe.skipIf(!RUN)("0G Compute live TEE inference", () => {
  it(
    "returns a real, verifiable 0g-tee envelope attestation",
    async () => {
      const privateKey = process.env.COMPUTE_PRIVATE_KEY;
      const providerAddress = process.env.TEE_PROVIDER_ADDRESS;
      const rpcUrl = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
      if (!privateKey || !providerAddress) {
        throw new Error("live compute test needs COMPUTE_PRIVATE_KEY and TEE_PROVIDER_ADDRESS");
      }

      const provider = await createZeroGDirectProvider({ privateKey, rpcUrl, providerAddress });
      const { text, attestation } = await provider.complete("Reply with the single word: ping");

      console.log("teeSigner:", provider.teeSignerAddress, "| answer:", JSON.stringify(text));
      expect(attestation.source).toBe("0g-tee");
      expect(verifyAttestation(attestation)).toBe(true);
      expect(attestation.signerAddress.toLowerCase()).toBe(provider.teeSignerAddress.toLowerCase());

      // The located content must be exactly the model text the player consumes.
      const bodyBytes = Buffer.from(attestation.rawResponseBody.slice(2), "hex");
      const slice = bodyBytes
        .subarray(attestation.contentOffset, attestation.contentOffset + attestation.contentLen)
        .toString("utf8");
      expect(JSON.parse(`"${slice}"`)).toBe(text); // un-escape the JSON string value
    },
    180_000,
  );
});
