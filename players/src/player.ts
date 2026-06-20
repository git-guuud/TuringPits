import { createHash } from "node:crypto";
import { parseDecision } from "./decision.js";
import { parseReason } from "./reason.js";
import { buildDecisionPrompt, buildDiscussionPrompt, buildReasonPrompt, buildSpeechPrompt } from "./prompt.js";
import { cleanDaySpeech, cleanNightReason, namifySeats } from "./sanitize.js";
import type { InferenceProvider, PlayerTurn, SamplingOptions, TurnContext } from "./types.js";

/** Temperature for the non-signed reason/speech/discussion calls (breaks mode-collapse). */
const SPEECH_TEMPERATURE = 0.8;

/** A deterministic per-(seat,turn,stage) seed so seats diverge yet a match stays reproducible. */
function callSeed(ctx: TurnContext, stage: string): number {
  const d = ctx.decisionStub;
  const key = `${d.nonce}:${ctx.persona.seat}:${d.round}:${d.phase}:${d.action}:${stage}`;
  return createHash("sha256").update(key).digest().readUInt32BE(0);
}

function sampling(ctx: TurnContext, stage: string): SamplingOptions {
  return { temperature: SPEECH_TEMPERATURE, seed: callSeed(ctx, stage) };
}

/** A seat's display name from the roster, falling back to "seat N" when no roster is supplied. */
function seatName(ctx: TurnContext, seat: number): string {
  return ctx.roster?.find((p) => p.seat === seat)?.name ?? `seat ${seat}`;
}

/** The public speeches said so far this match — used to detect (and reject) parroting. */
function priorSpeeches(ctx: TurnContext): string[] {
  return ctx.transcript.map(([, text]) => text);
}

/** Names of seats that have actually spoken in the public transcript (the only players one can
 *  legitimately react to). Used to reject day speech that invents words for a still-silent seat. */
function spokenNames(ctx: TurnContext): string[] {
  return [...new Set(ctx.transcript.map(([seat]) => seat))].map((seat) => seatName(ctx, seat));
}

// Per-seat distinct fallback lines, so two seats that both fall back never land on the same text.
// There must be at least as many as the max seat count (8) or `seat % length` collides and two
// players say an identical canned line in the same round.
const DISCUSSION_FALLBACKS = [
  "I'd rather hold back and see who pushes hardest in today's vote before I commit.",
  "Nothing solid from me yet — I want to hear more before I point a finger at anyone.",
  "I'm not ready to accuse anyone; let's see how today's vote actually breaks down.",
  "I'll keep my read to myself for now and weigh how people cast their votes today.",
  "Too early for me to call it — I'm still weighing what each of you has said.",
  "I don't have a clear suspect, so I'll watch the vote and see who lines up where.",
  "No firm read from me — I want to see who's willing to actually commit to a vote.",
  "I'm staying open for now; the way people vote today will tell us more than talk has.",
];
const VOTE_FALLBACKS: ((name: string) => string)[] = [
  (n) => `My read is thin, but I'll cast my vote for ${n} today and see what it tells us.`,
  (n) => `I'm not certain, yet ${n} is my pick in today's vote on limited information.`,
  (n) => `Without a strong read, I'll go with ${n} for today's vote.`,
  (n) => `I'll vote ${n} today — a provisional call, not a confident one.`,
  (n) => `${n} gets my vote today, though I admit my read is still thin.`,
  (n) => `On balance I'll put my vote on ${n} today, even if my read is far from settled.`,
  (n) => `I'll point my vote at ${n} for now; it's a soft read, not a firm accusation.`,
  (n) => `${n} is where I'll land today — more a hunch than a hard case, I'll admit.`,
];

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
      const reasonResult = await this.provider.complete(buildReasonPrompt(ctx), sampling(ctx, "reason"));
      try {
        chosen = parseReason(reasonResult.text, ctx.legalTargets);
        break;
      } catch {
        // Keep resampling; the deterministic default above stands if every attempt fails.
      }
    }

    // 2. Speak — DAY ONLY. Night actions (kill/save/investigate) are secret: there is NO public
    //    speech at night, only the private reasoning + the signed action. At night the turn
    //    carries that reasoning for the post-game record, and `playMatch` never broadcasts it;
    //    in the day debate the player justifies its chosen vote aloud. Free-form, not signed.
    let speech = chosen.reason;
    if (ctx.decisionStub.phase === "day") {
      const speechPrompt = buildSpeechPrompt(ctx, chosen.target, chosen.reason);
      const speechResult = await this.provider.complete(speechPrompt, sampling(ctx, "speech"));
      // Moderator guard: keep night-confusion / "silence = guilt" out of the broadcast vote speech.
      const voteFb = VOTE_FALLBACKS[ctx.persona.seat % VOTE_FALLBACKS.length]!;
      speech = await cleanDaySpeech(
        this.provider, speechPrompt, speechResult.text,
        voteFb(seatName(ctx, chosen.target)),
        ctx.roster?.map((p) => p.name) ?? [],
        priorSpeeches(ctx),
        sampling(ctx, "speech-fix"),
        // The vote target may legitimately be named even if still silent (you're voting for them).
        [...spokenNames(ctx), seatName(ctx, ctx.persona.seat), seatName(ctx, chosen.target)],
      );
      speech = namifySeats(speech, ctx.roster ?? []); // belt-and-suspenders: no stray "seat N" in speech
    } else {
      // NIGHT private reasoning: scrub invented reads (esp. round 1, when no one could have been
      // observed), then swap any "seat N" for the name, so the audit log shows neither made-up
      // behaviour nor seat numbers. Grounded reasoning passes the scrub through unchanged.
      speech = namifySeats(
        cleanNightReason(chosen.reason, ctx.decisionStub.action, seatName(ctx, chosen.target)),
        ctx.roster ?? [],
      );
    }

    // 3. Decide: emit the canonical decision for the chosen target. Pinning the accepted target
    //    to `chosen.target` keeps speech and action in lockstep; a drifting/non-canonical sample
    //    is resampled (never repaired — that would invalidate the signature).
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.decisionRetries; attempt++) {
      const decisionResult = await this.provider.complete(buildDecisionPrompt(ctx, chosen.target));
      try {
        const structuredDecision = parseDecision(decisionResult.text, ctx.decisionStub, [chosen.target]);
        return { speech, structuredDecision, attestation: decisionResult.attestation };
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `decision inference failed after ${this.decisionRetries + 1} attempt(s): ` +
        (lastErr instanceof Error ? lastErr.message : String(lastErr)),
    );
  }

  /**
   * DAY discussion-pass turn: speak free-form into the debate, grounded purely in the public
   * transcript. Produces NO structured decision and NO attestation — discussion speech is never
   * signed and never settles. No reason call is made: the discussion prompt takes no pre-chosen
   * target (pushing one makes a weak model fabricate behaviour to justify it), and the binding
   * vote target is chosen later in `takeTurn`'s own reason call.
   */
  async discuss(ctx: TurnContext): Promise<{ speech: string }> {
    const prompt = buildDiscussionPrompt(ctx);
    const speechResult = await this.provider.complete(prompt, sampling(ctx, "discuss"));
    // Moderator guard: a polluted opener cascades through the whole table, so scrub it before it
    // enters the public transcript. Falls back to an honest no-read line if a clean rewrite fails.
    const speech = await cleanDaySpeech(
      this.provider, prompt, speechResult.text,
      DISCUSSION_FALLBACKS[ctx.persona.seat % DISCUSSION_FALLBACKS.length]!,
      ctx.roster?.map((p) => p.name) ?? [],
      priorSpeeches(ctx),
      sampling(ctx, "discuss-fix"),
      // In discussion you may react only to players who have already spoken (plus yourself).
      [...spokenNames(ctx), seatName(ctx, ctx.persona.seat)],
    );
    return { speech };
  }
}
