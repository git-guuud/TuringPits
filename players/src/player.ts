import { parseDecision } from "./decision.js";
import { parseReason } from "./reason.js";
import { buildDecisionPrompt, buildReasonPrompt, buildSpeechPrompt } from "./prompt.js";
import type { InferenceProvider, PlayerTurn, TurnContext } from "./types.js";

export interface PlayerOptions {
  /**
   * How many extra times to re-run an inference whose output is unusable (default 0). The
   * decision text IS the signed bytes, so a bad decision can never be repaired — only
   * resampled. The same cap also bounds reason resampling before the deterministic fallback.
   */
  readonly decisionRetries?: number;
}

/**
 * One Mafia seat. Wraps an `InferenceProvider` (real 0G Compute, or the labeled mock) and
 * runs the three-call turn: **reason → speak → decide**.
 *
 * 1. *Reason* (private, not signed): the player sees everything it legitimately knows and
 *    privately picks a legal target. Unusable output is resampled, then falls back to a
 *    deterministic legal pick so a weak model can never stall a live match.
 * 2. *Speak* (public, streamed): given the chosen target + private reasoning, it makes its
 *    in-character case — so the speech justifies the action instead of diverging from it.
 * 3. *Decide* (constrained, signed): it emits the canonical decision for that exact target.
 *    The output IS the signed bytes the on-chain verifier reconstructs, so a non-canonical or
 *    off-target sample is resampled (pinned to the reasoned target), never silently corrected.
 *
 * BYOM-ready: each seat holds its own provider, so seats can later run distinct models.
 */
export class Player {
  private readonly decisionRetries: number;

  constructor(private readonly provider: InferenceProvider, opts: PlayerOptions = {}) {
    this.decisionRetries = Math.max(0, opts.decisionRetries ?? 0);
  }

  async takeTurn(ctx: TurnContext): Promise<PlayerTurn> {
    // 1. Reason: privately choose a target. Resample on unusable output; fall back to a
    //    deterministic legal pick so a poor reasoning turn can never stall the match.
    let chosen = { target: ctx.legalTargets[0] ?? 0, reason: "" };
    for (let attempt = 0; attempt <= this.decisionRetries; attempt++) {
      const reasonResult = await this.provider.complete(buildReasonPrompt(ctx));
      try {
        chosen = parseReason(reasonResult.text, ctx.legalTargets);
        break;
      } catch {
        // Keep resampling; the deterministic default above stands if every attempt fails.
      }
    }

    // 2. Speak: justify the chosen target aloud. Free-form, not load-bearing — its attestation
    //    is kept on 0G Storage later, but settlement only ever consumes the decision below.
    const speechResult = await this.provider.complete(buildSpeechPrompt(ctx, chosen.target, chosen.reason));

    // 3. Decide: emit the canonical decision for the chosen target. Pinning the accepted target
    //    to `chosen.target` keeps speech and action in lockstep; a drifting/non-canonical sample
    //    is resampled (never repaired — that would invalidate the signature).
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.decisionRetries; attempt++) {
      const decisionResult = await this.provider.complete(buildDecisionPrompt(ctx, chosen.target));
      try {
        const structuredDecision = parseDecision(decisionResult.text, ctx.decisionStub, [chosen.target]);
        return { speech: speechResult.text, structuredDecision, attestation: decisionResult.attestation };
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `decision inference failed after ${this.decisionRetries + 1} attempt(s): ` +
        (lastErr instanceof Error ? lastErr.message : String(lastErr)),
    );
  }
}
