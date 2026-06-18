import { describe, it, expect } from "vitest";
import { hexlify, toUtf8Bytes } from "ethers";
import { verifyAttestation } from "./attestation.js";
import { MockLocalProvider } from "./provider.js";
import type { Attestation } from "./types.js";

const FIXED_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("verifyAttestation (live 0G-TEE envelope model)", () => {
  it("accepts an envelope signature that recovers the claimed signer", async () => {
    const provider = new MockLocalProvider(FIXED_KEY);
    const { attestation } = await provider.complete("the model output");
    expect(verifyAttestation(attestation)).toBe(true);
  });

  it("rejects when the claimed signer is a different address (forged)", async () => {
    const provider = new MockLocalProvider(FIXED_KEY);
    const { attestation } = await provider.complete("the model output");
    const forged: Attestation = {
      ...attestation,
      signerAddress: "0x000000000000000000000000000000000000dEaD",
    };
    expect(verifyAttestation(forged)).toBe(false);
  });

  it("rejects when the response body was swapped after signing", async () => {
    const provider = new MockLocalProvider(FIXED_KEY);
    const { attestation } = await provider.complete("the model output");
    // Swap the body the envelope committed to — sha256 no longer matches what was signed.
    const tampered: Attestation = {
      ...attestation,
      rawResponseBody: hexlify(toUtf8Bytes("a totally different response body")),
    };
    expect(verifyAttestation(tampered)).toBe(false);
  });

  it("rejects when a provider-metadata field is altered after signing", async () => {
    const provider = new MockLocalProvider(FIXED_KEY);
    const { attestation } = await provider.complete("the model output");
    const tampered: Attestation = { ...attestation, providerIdentity: "not-aliyun" };
    expect(verifyAttestation(tampered)).toBe(false);
  });

  it("returns false on a malformed signature instead of throwing", async () => {
    const provider = new MockLocalProvider(FIXED_KEY);
    const { attestation } = await provider.complete("the model output");
    const broken: Attestation = { ...attestation, signature: "0xnotasignature" };
    expect(verifyAttestation(broken)).toBe(false);
  });
});
