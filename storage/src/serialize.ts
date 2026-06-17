/**
 * Deterministic serialization for the Evidence Layer (TODO.md Day 4).
 *
 * Two artifact kinds get locked on 0G Storage:
 *  - personas: the public seat personas, uploaded *before* a match.
 *  - match:    the full attested transcript (speech + structured decisions + TEE
 *              signatures), uploaded *after* the match.
 *
 * Serialization is canonical (recursively sorted object keys, compact output) so the same
 * logical evidence always produces byte-identical content — and therefore the same 0G
 * Storage root. That is what makes the stored evidence content-addressed and auditable:
 * anyone can re-serialize the public data and confirm it hashes to the announced root.
 */
import { createHash } from "node:crypto";
import type { Faction } from "@turingpits/engine";
import type { Persona, RecordedTurn } from "@turingpits/players";

/** SHA-256 of `bytes`, as a `0x`-prefixed lowercase hex string. */
export function sha256Hex(bytes: Uint8Array): string {
  return "0x" + createHash("sha256").update(bytes).digest("hex");
}

/**
 * Canonical JSON: objects emit their keys in sorted order (recursively), arrays keep their
 * order, output is compact. Deterministic for any JSON-safe value.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
    .join(",");
  return "{" + body + "}";
}

/** Parse bytes produced by the serializers back into a plain object. */
export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Pre-match evidence: the public seat personas. */
export function serializePersonas(personas: readonly Persona[]): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({ kind: "turingpits/personas", personas }),
  );
}

/** Post-match evidence: the winner and the full attested transcript. */
export function serializeMatch(match: {
  readonly winner: Faction | null;
  readonly turns: readonly RecordedTurn[];
}): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({ kind: "turingpits/match", winner: match.winner, turns: match.turns }),
  );
}
