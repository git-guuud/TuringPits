import { describe, expect, it } from "vitest";
import {
  commitRoles,
  generateSalt,
  roleCommitPreimage,
  verifyRoleReveal,
} from "./commit.js";
import { assignRoles } from "./moderator.js";
import type { Role } from "./types.js";

const ROLES: Role[] = ["MAFIA", "TOWN", "DETECTIVE", "DOCTOR", "TOWN"];
const ZERO_SALT = "0x" + "00".repeat(32);

describe("roleCommitPreimage", () => {
  it("packs role enums (MAFIA=0,DOCTOR=1,DETECTIVE=2,TOWN=3) then the 32-byte salt", () => {
    // Mirrors Solidity `abi.encodePacked(uint8[] roles, bytes32 salt)` — the format the
    // Day-5 verifier reconstructs from typed calldata. MAFIA,TOWN,DETECTIVE,DOCTOR,TOWN
    // → bytes 00 03 02 01 03, followed by 32 zero bytes.
    expect(roleCommitPreimage(ROLES, ZERO_SALT).toString("hex")).toBe(
      "0003020103" + "00".repeat(32),
    );
  });
});

describe("commitRoles", () => {
  it("is sha256 over the canonical preimage (the SHA-256 precompile reconstructs on-chain)", () => {
    expect(commitRoles(ROLES, ZERO_SALT)).toBe(
      "0xc6f1c9589851267a6b909dde4bf109fce331c211a4e29d0b5e8e4b984d49507c",
    );
  });

  it("is deterministic for the same roles and salt", () => {
    const salt = generateSalt();
    expect(commitRoles(ROLES, salt)).toBe(commitRoles(ROLES, salt));
  });
});

describe("generateSalt", () => {
  it("produces a 0x-prefixed 32-byte hex value", () => {
    expect(generateSalt()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("produces a different salt each call", () => {
    expect(generateSalt()).not.toBe(generateSalt());
  });
});

describe("verifyRoleReveal", () => {
  it("accepts the true role assignment and salt", () => {
    const salt = generateSalt();
    const commit = commitRoles(ROLES, salt);
    expect(verifyRoleReveal(commit, ROLES, salt)).toBe(true);
  });

  it("rejects a tampered role assignment (one seat's role swapped)", () => {
    const salt = generateSalt();
    const commit = commitRoles(ROLES, salt);
    const tampered: Role[] = [...ROLES];
    tampered[0] = "TOWN"; // hide the mafia
    expect(verifyRoleReveal(commit, tampered, salt)).toBe(false);
  });

  it("rejects the right roles revealed under the wrong salt", () => {
    const commit = commitRoles(ROLES, generateSalt());
    expect(verifyRoleReveal(commit, ROLES, generateSalt())).toBe(false);
  });

  it("rejects a reordered role assignment", () => {
    const salt = generateSalt();
    const commit = commitRoles(ROLES, salt);
    const reordered: Role[] = [ROLES[1]!, ROLES[0]!, ...ROLES.slice(2)];
    expect(verifyRoleReveal(commit, reordered, salt)).toBe(false);
  });

  it("returns false (never throws) on a malformed salt", () => {
    const commit = commitRoles(ROLES, generateSalt());
    expect(verifyRoleReveal(commit, ROLES, "0xnothex")).toBe(false);
    expect(verifyRoleReveal(commit, ROLES, "0x00")).toBe(false);
  });

  it("round-trips a seeded assignment: commit before betting, reveal at settlement", () => {
    const seed = "0x" + "ab".repeat(32);
    const roles = assignRoles(seed, 7);
    const salt = generateSalt();
    const commit = commitRoles(roles, salt);
    // The settlement reveal — roles + salt only; the secret seed is never disclosed.
    expect(verifyRoleReveal(commit, roles, salt)).toBe(true);
  });
});
