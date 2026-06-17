import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Role } from "./types.js";

/**
 * Commit-reveal for the role assignment.
 *
 * The server assigns roles from a secret seed, then publishes a commit
 * `hash(roles + salt)` to the contract *before* betting opens. At settlement it reveals
 * `(roles, salt)` and the contract checks `hash(reveal) == commit`, binding the server to a
 * role assignment fixed before any bet — and never disclosing the secret seed itself.
 *
 * The commit is `sha256(abi.encodePacked(uint8[] roles, bytes32 salt))`: each role is its
 * enum index (1 byte), packed in seat order, followed by the 32-byte salt. The Day-5
 * Solidity verifier reconstructs the identical preimage from typed calldata and hashes it
 * with the SHA-256 precompile (address 0x2) — the same hash the §A response-verification
 * path already uses, so no new on-chain primitive is needed.
 */

/** Canonical role → enum index. MUST match the Solidity `enum Role` declaration order. */
const ROLE_ENUM: Record<Role, number> = { MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 };

const SALT_BYTES = 32;

/** Parse a `0x`-prefixed 32-byte hex salt into bytes; throws if it isn't exactly 32 bytes. */
function saltToBytes(salt: string): Buffer {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    throw new Error(`salt must be a 0x-prefixed ${SALT_BYTES}-byte hex string`);
  }
  return Buffer.from(salt.slice(2), "hex");
}

/**
 * The exact bytes the commit hashes: packed role-enum bytes (seat order) ++ 32-byte salt.
 * Mirrors Solidity `abi.encodePacked(uint8[] roles, bytes32 salt)`.
 */
export function roleCommitPreimage(roles: readonly Role[], salt: string): Buffer {
  const roleBytes = Buffer.from(
    roles.map((r) => {
      const v = ROLE_ENUM[r];
      if (v === undefined) throw new Error(`unknown role ${r}`);
      return v;
    }),
  );
  return Buffer.concat([roleBytes, saltToBytes(salt)]);
}

/** A cryptographically-random 32-byte salt as a `0x`-prefixed hex string (Solidity bytes32). */
export function generateSalt(): string {
  return "0x" + randomBytes(SALT_BYTES).toString("hex");
}

/** Commit = `sha256(roleCommitPreimage(roles, salt))`, `0x`-prefixed hex. */
export function commitRoles(roles: readonly Role[], salt: string): string {
  return "0x" + createHash("sha256").update(roleCommitPreimage(roles, salt)).digest("hex");
}

/**
 * Verify a revealed `(roles, salt)` reproduces `commit`. Returns `false` (never throws) on a
 * mismatch or any malformed input, so settlement can gate on the boolean — the same
 * never-throw contract as `verifyAttestation`.
 */
export function verifyRoleReveal(commit: string, roles: readonly Role[], salt: string): boolean {
  try {
    const expected = Buffer.from(commit.replace(/^0x/, ""), "hex");
    const actual = createHash("sha256").update(roleCommitPreimage(roles, salt)).digest();
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
