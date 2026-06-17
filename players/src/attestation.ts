import { verifyMessage } from "ethers";
import type { Attestation } from "./types.js";

/**
 * Verify a TEE attestation locally — the exact check the Day-5 Solidity verifier mirrors.
 *
 * 0G Compute signs with EIP-191 `personal_sign` (`myTasks.md §A`). `ethers.verifyMessage`
 * re-applies the EIP-191 prefix and runs `ecrecover`, then we compare the recovered
 * address against the claimed signer. On-chain this is `ecrecover` over
 * `keccak256("\x19Ethereum Signed Message:\n<len>" + text)` vs the registered provider key.
 *
 * Returns `false` (never throws) on a malformed/forged/tampered signature so callers can
 * gate settlement on the boolean.
 */
export function verifyAttestation(att: Attestation): boolean {
  try {
    const recovered = verifyMessage(att.signedText, att.signature);
    return recovered.toLowerCase() === att.signerAddress.toLowerCase();
  } catch {
    return false;
  }
}
