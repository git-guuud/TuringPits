import type { Decision } from "./types.js";

/**
 * Canonical encoding of a structured decision — the exact bytes the TEE signs.
 *
 * Fixed key order, no whitespace. The Day-5 Solidity verifier reconstructs this same
 * string from typed calldata (string-building, not JSON parsing), hashes it, and
 * `ecrecover`s. Key order and formatting must therefore stay byte-stable here.
 *
 * `nonce` is JSON-string-escaped so an adversarial nonce cannot break out of the field.
 */
export function encodeDecision(d: Decision): string {
  return (
    "{" +
    `"nonce":${JSON.stringify(d.nonce)},` +
    `"phase":${JSON.stringify(d.phase)},` +
    `"round":${d.round},` +
    `"player":${d.player},` +
    `"action":${JSON.stringify(d.action)},` +
    `"target":${d.target}` +
    "}"
  );
}
