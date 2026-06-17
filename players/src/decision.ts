import type { Decision } from "@turingpits/engine";
import { encodeDecision } from "@turingpits/engine";

/**
 * Parse and validate a player's decision-inference output into a `Decision`.
 *
 * The model's *literal output text* is what the TEE signs and what the on-chain verifier
 * reconstructs from typed calldata, so we cannot repair it after the fact. We therefore
 * require it to be byte-identical to the canonical encoding of a `Decision` whose fixed
 * fields match `stub` and whose `target` is legal. Anything else throws — that turn's
 * inference must be retried rather than silently corrected.
 */
export function parseDecision(
  text: string,
  stub: Omit<Decision, "target">,
  legalTargets: readonly number[],
): Decision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`decision output is not valid JSON: ${text}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`decision output is not an object: ${text}`);
  }
  const p = parsed as Record<string, unknown>;

  if (p.nonce !== stub.nonce) throw new Error(`decision nonce mismatch (expected ${stub.nonce})`);
  if (p.phase !== stub.phase) throw new Error(`decision phase mismatch (expected ${stub.phase})`);
  if (p.round !== stub.round) throw new Error(`decision round mismatch (expected ${stub.round})`);
  if (p.player !== stub.player) throw new Error(`decision player mismatch (expected ${stub.player})`);
  if (p.action !== stub.action) throw new Error(`decision action mismatch (expected ${stub.action})`);

  const target = p.target;
  if (typeof target !== "number" || !Number.isInteger(target) || !legalTargets.includes(target)) {
    throw new Error(`illegal decision target ${String(target)} (legal: ${legalTargets.join(", ")})`);
  }

  const decision: Decision = { ...stub, target };
  if (encodeDecision(decision) !== text) {
    throw new Error(`decision output is not canonical bytes: ${text}`);
  }
  return decision;
}
