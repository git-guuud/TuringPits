import type { Decision } from "@turingpits/engine";

/**
 * Where an attestation's signature came from. The on-chain verifier only ever trusts
 * `"0g-tee"`. `"MOCK-local"` is a locally-generated test key — real ECDSA, but NOT a
 * 0G TEE provider — used only when live Compute access is unavailable. Never silently
 * treated as a real attestation.
 */
export type AttestationSource = "0g-tee" | "MOCK-local";

/**
 * A provider's TEE attestation over an inference output — the **live-confirmed envelope
 * model** (`STATUS.md` → "0G integration — confirmed facts", 2026-06-17).
 *
 * 0G Compute does NOT sign the model text directly. It signs an EIP-191 `personal_sign`
 * envelope over the *response*:
 *
 *   `reqHashHex : sha256(rawResponseBody) : providerType : providerIdentity : tlsFingerprint`
 *
 * colon-joined, where `sha256(rawResponseBody)` is lowercase hex. `ecrecover` (prefix
 * re-applied) recovers `signerAddress` — the provider's on-chain `teeSignerAddress`. The
 * decision the moderator consumes lives *inside* `rawResponseBody` as the model's
 * `choices[0].message.content`; `contentOffset`/`contentLen` locate it so settlement can
 * bind the typed decision to the exact signed bytes (`_sliceEquals` in `MafiaMarket.sol`).
 *
 * This carries everything `MafiaMarket.settle()`'s `Move` + market metadata needs, so an
 * attested turn maps straight to on-chain calldata (`toSettlementMove`). It mirrors
 * `contracts/contracts/lib/TeeEnvelope.sol` exactly.
 */
export interface Attestation {
  /** EIP-191 signature over the reconstructed envelope, as a 0x-hex string. */
  readonly signature: string;
  /** Address recovered/expected from the signature (the provider's TEE signer). */
  readonly signerAddress: string;
  readonly source: AttestationSource;
  /** Raw HTTP response body the TEE hashed, as 0x-hex of its UTF-8 bytes. */
  readonly rawResponseBody: string;
  /** Byte offset of the model `content` (the decision/speech text) within the body. */
  readonly contentOffset: number;
  /** Byte length of that content. */
  readonly contentLen: number;
  /** `sha256(request)` lowercase hex — opaque to us; envelope part[0]. */
  readonly reqHashHex: string;
  /** Provider metadata forming envelope parts[2..4]. Constant per provider/match. */
  readonly providerType: string;
  readonly providerIdentity: string;
  readonly tlsFingerprint: string;
}

/** The two artifacts a player turn produces (design spec §3, the two-layer turn). */
export interface PlayerTurn {
  /** Free-form natural-language reasoning/chatter. Streamed to UI; not load-bearing. */
  readonly speech: string;
  /** The constrained decision the moderator + Solidity state machine consume. */
  readonly structuredDecision: Decision;
  /** Provider TEE envelope attestation over the response body carrying this decision. */
  readonly attestation: Attestation;
}

/** Public persona for a seat (BYOM-ready: each seat can later carry its own model). */
export interface Persona {
  readonly seat: number;
  readonly name: string;
  readonly blurb: string;
}

/** One detective investigation this seat privately performed, with its revealed alignment. */
export interface PrivateInvestigation {
  readonly round: number;
  readonly target: number;
  /** Alignment the investigation revealed: `"MAFIA"` or `"TOWN"`. */
  readonly faction: string;
}

/** One of this seat's own prior moves, replayed to it as private memory. */
export interface PastAction {
  readonly round: number;
  readonly phase: string;
  readonly action: string;
  readonly target: number;
}

/**
 * What a player legitimately sees when deciding: its own seat/role, the living seats,
 * the public transcript so far, the constraints of the move it must make this turn, and the
 * private knowledge its role grants (Mafia teammates, detective findings, its own history).
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
  /** MAFIA only: the seats of this player's fellow Mafia. */
  readonly teammates?: readonly number[];
  /** DETECTIVE only: this player's own investigation results so far. */
  readonly investigations?: readonly PrivateInvestigation[];
  /** This seat's own prior moves (e.g. doctor saves, past votes) — private memory. */
  readonly ownHistory?: readonly PastAction[];
}

/**
 * One TEE-attested inference. Implemented by the real 0G Compute provider and by the
 * labeled local mock. `complete` returns the model text plus the attestation over it.
 */
export interface InferenceProvider {
  complete(prompt: string): Promise<{ text: string; attestation: Attestation }>;
}
