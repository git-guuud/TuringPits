import type { Decision } from "@turingpits/engine";

/**
 * Where an attestation's signature came from. The on-chain verifier only ever trusts
 * `"0g-tee"`. `"MOCK-local"` is a locally-generated test key — real ECDSA, but NOT a
 * 0G TEE provider — used only when live Compute access is unavailable. Never silently
 * treated as a real attestation.
 */
export type AttestationSource = "0g-tee" | "MOCK-local";

/**
 * A provider's TEE attestation over an inference output.
 *
 * Per `myTasks.md §A`: 0G Compute signs the **model response text** with EIP-191
 * `personal_sign` (secp256k1/ECDSA), so `ecrecover` (with the EIP-191 prefix re-applied)
 * recovers `signerAddress`. For decision turns, `signedText` IS the canonical decision
 * string, so the signature binds the provider to the exact decision.
 */
export interface Attestation {
  /** The exact bytes the TEE signed — the model response text. */
  readonly signedText: string;
  /** EIP-191 signature over `signedText`, as a 0x-hex string. */
  readonly signature: string;
  /** Address recovered/expected from the signature (the provider's TEE signer). */
  readonly signerAddress: string;
  readonly source: AttestationSource;
}

/** The two artifacts a player turn produces (design spec §3, the two-layer turn). */
export interface PlayerTurn {
  /** Free-form natural-language reasoning/chatter. Streamed to UI; not load-bearing. */
  readonly speech: string;
  /** The constrained decision the moderator + Solidity state machine consume. */
  readonly structuredDecision: Decision;
  /** Provider attestation over the canonical decision string (= `encodeDecision`). */
  readonly attestation: Attestation;
}

/** Public persona for a seat (BYOM-ready: each seat can later carry its own model). */
export interface Persona {
  readonly seat: number;
  readonly name: string;
  readonly blurb: string;
}

/**
 * What a player legitimately sees when deciding: its own seat/role, the living seats,
 * the public transcript so far, and the constraints of the move it must make this turn.
 */
export interface TurnContext {
  readonly persona: Persona;
  readonly role: string;
  /** Living seat indices. */
  readonly alive: readonly number[];
  /** Public speech log so far: `[seat, text]` pairs. */
  readonly transcript: readonly (readonly [number, string])[];
  /** The decision the moderator expects this turn, minus the target (the model picks it). */
  readonly decisionStub: Omit<Decision, "target">;
  /** Legal target seats for this decision. */
  readonly legalTargets: readonly number[];
}

/**
 * One TEE-attested inference. Implemented by the real 0G Compute provider and by the
 * labeled local mock. `complete` returns the model text plus the attestation over it.
 */
export interface InferenceProvider {
  complete(prompt: string): Promise<{ text: string; attestation: Attestation }>;
}
