import { parseDecision } from "./decision.js";
import { buildDecisionPrompt, buildSpeechPrompt } from "./prompt.js";
import type { InferenceProvider, PlayerTurn, TurnContext } from "./types.js";

/**
 * One Mafia seat. Wraps an `InferenceProvider` (real 0G Compute, or the labeled mock) and
 * turns a `TurnContext` into the two-layer turn (design spec §3): free-form speech for the
 * UI, plus a TEE-attested structured decision for settlement.
 *
 * BYOM-ready: each seat holds its own provider, so seats can later run distinct
 * models/providers without changing this interface. Today every seat shares one model.
 */
export class Player {
  constructor(private readonly provider: InferenceProvider) {}

  async takeTurn(ctx: TurnContext): Promise<PlayerTurn> {
    // Speech: free-form, not load-bearing. Its attestation is kept on 0G Storage later,
    // but settlement only ever consumes the decision attestation below.
    const speechResult = await this.provider.complete(buildSpeechPrompt(ctx));

    // Decision: a constrained inference whose entire output IS the canonical decision
    // string, so the attestation binds the provider to the exact decision bytes the
    // on-chain verifier reconstructs. A non-canonical/illegal output throws — never
    // silently corrected, because that would invalidate the signature.
    const decisionResult = await this.provider.complete(buildDecisionPrompt(ctx));
    const structuredDecision = parseDecision(
      decisionResult.text,
      ctx.decisionStub,
      ctx.legalTargets,
    );

    return {
      speech: speechResult.text,
      structuredDecision,
      attestation: decisionResult.attestation,
    };
  }
}
