import { verifyMessage } from "ethers";
import { joinEnvelope } from "./envelope.js";
import type { Attestation } from "./types.js";

/**
 * Rebuild the live-confirmed 0G-TEE envelope from an attestation's parts. Byte-for-byte
 * identical to the string `TeeEnvelope.recover` reconstructs on-chain, so a signature that
 * recovers here recovers there too.
 */
export function rebuildEnvelope(att: Attestation): string {
  return joinEnvelope(att.reqHashHex, att.rawResponseBody, att);
}

/**
 * Verify a TEE attestation locally — the exact check the deployed Solidity verifier mirrors
 * (`contracts/contracts/lib/TeeEnvelope.sol`).
 *
 * Rebuilds the envelope from the (claimed) response body + metadata and `ecrecover`s the
 * EIP-191 signature. `ethers.verifyMessage` re-applies the `"\x19Ethereum Signed Message:\n"`
 * prefix exactly as `_ethSignedHash` does on-chain. Because the envelope embeds
 * `sha256(rawResponseBody)`, this also catches a body that was swapped after signing: the
 * recomputed hash no longer matches what the provider signed, so recovery yields a different
 * address and the check fails.
 *
 * Returns `false` (never throws) on a malformed/forged/tampered signature so callers can gate
 * settlement on the boolean.
 */
export function verifyAttestation(att: Attestation): boolean {
  try {
    const recovered = verifyMessage(rebuildEnvelope(att), att.signature);
    return recovered.toLowerCase() === att.signerAddress.toLowerCase();
  } catch {
    return false;
  }
}
