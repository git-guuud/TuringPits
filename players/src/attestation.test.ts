import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import { verifyAttestation } from "./attestation.js";
import type { Attestation } from "./types.js";

describe("verifyAttestation", () => {
  it("accepts an EIP-191 signature that recovers the claimed signer", async () => {
    const wallet = Wallet.createRandom();
    const text = '{"nonce":"abc","phase":"day","round":1,"player":2,"action":"vote","target":3}';
    const signature = await wallet.signMessage(text);

    const att: Attestation = {
      signedText: text,
      signature,
      signerAddress: wallet.address,
      source: "MOCK-local",
    };

    expect(verifyAttestation(att)).toBe(true);
  });

  it("rejects a signature that recovers a different address (forged/tampered)", async () => {
    const wallet = Wallet.createRandom();
    const text = "the real output";
    const signature = await wallet.signMessage(text);

    const att: Attestation = {
      signedText: text,
      signature,
      signerAddress: Wallet.createRandom().address, // claims a different signer
      source: "MOCK-local",
    };

    expect(verifyAttestation(att)).toBe(false);
  });

  it("rejects when the signed text was altered after signing", async () => {
    const wallet = Wallet.createRandom();
    const signature = await wallet.signMessage("original output");

    const att: Attestation = {
      signedText: "tampered output",
      signature,
      signerAddress: wallet.address,
      source: "MOCK-local",
    };

    expect(verifyAttestation(att)).toBe(false);
  });

  it("returns false on a malformed signature instead of throwing", () => {
    const att: Attestation = {
      signedText: "x",
      signature: "0xnotasignature",
      signerAddress: Wallet.createRandom().address,
      source: "MOCK-local",
    };

    expect(verifyAttestation(att)).toBe(false);
  });
});
