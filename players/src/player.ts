import { createHash } from "node:crypto";
import { parseDecision } from "./decision.js";
import { parseReason, parseVoteSpeech } from "./reason.js";
import { buildDecisionPrompt, buildDiscussionPrompt, buildReasonPrompt, buildSpeechPrompt, buildVoteSpeechPrompt, recentTranscript } from "./prompt.js";
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

/** Public speeches said so far by OTHER seats — used to detect (and reject) parroting. A seat's OWN
 *  earlier lines are excluded on purpose: a power role must be free to RESTATE its established claim
 *  across rounds (a Detective re-asserting "I investigated X — he's Mafia", a Mafia holding its bluff
 *  line, an accused repeating its defence) without the echo guard reading that consistency as parroting
 *  and collapsing the line to a bland fallback — the dominant reason genuine speeches were filtered out
 *  from round 2 on. Echoing ANOTHER player's wording is still caught, which is all the ECHO_NOTE claims. */
function othersPriorSpeeches(ctx: TurnContext): string[] {
  // Compare only against the lines the model can SEE (the recent window) and only OTHER seats', so a
  // seat is never rejected for "echoing" a line that was elided or that it said itself.
  return recentTranscript(ctx)
    .shown.filter(([seat]) => seat !== ctx.persona.seat)
    .map(([, text]) => text);
}

/** Names of seats this player holds CERTAIN knowledge about (its own investigation results). It may
 *  name these in public even after they have died — e.g. a Detective citing "I investigated X" — so
 *  they join the day-guard allow-list, which otherwise only permits LIVING seats. */
function knownNames(ctx: TurnContext): string[] {
  return (ctx.investigations ?? []).map((inv) => seatName(ctx, inv.target));
}

/** Names of every LIVING seat. Naming a living player as a suspect or addressing them is legitimate
 *  Mafia play — the thing that must NOT happen is fabricating their unobservable behaviour, which the
 *  BAD_SPEECH markers (silence/quiet/evasive/"hasn't spoken") catch directly. So the day guard allows
 *  any living name and lets the markers reject only the fabrication. Without this the model couldn't
 *  raise a fresh suspicion about anyone who hadn't yet reached their turn, and collapsed to a bland
 *  fallback — the single biggest source of the table's fence-sitting. Dead seats stay disallowed
 *  (you cannot vote or meaningfully accuse a corpse). */
function livingNames(ctx: TurnContext): string[] {
  return ctx.alive.map((s) => seatName(ctx, s));
}

/** Names of LIVING seats this Detective has personally cleared as TOWN. A Detective must never publicly
 *  push the day vote onto — or cast suspicion on — a seat its own investigation proved is Town; the
 *  discussion prompt steers it to vouch, but the weak model ignores that, so the day guard rejects such
 *  a line outright. Only LIVING clears matter (a dead clear can't be railroaded) and only for a
 *  Detective; every other role (and a Detective with no living Town result) gets [] — a no-op guard. */
function clearedTownNames(ctx: TurnContext): string[] {
  if (ctx.role !== "DETECTIVE") return [];
  const living = new Set(ctx.alive);
  return (ctx.investigations ?? [])
    .filter((inv) => inv.faction === "TOWN" && living.has(inv.target))
    .map((inv) => seatName(ctx, inv.target));
}

// Per-seat distinct fallback lines, used only when a seat's real speech can't pass the guard. They
// must stay SAFE (name no one, no hallucination markers) — but they are deliberately ACTIVE, not the
// old passive "I'll wait and watch" lines: a passive fallback in the transcript modelled disengagement
// for every later speaker and cascaded the whole table into fence-sitting. These instead PUSH the
// table to commit, so even a fallback keeps the game moving. There must be ≥ the max seat count (8)
// or `seat % length` collides and two players say an identical canned line in the same round.
const DISCUSSION_FALLBACKS = [
  "I won't be rushed, but I won't sit on my hands either — somebody give me a real reason to move on a name and I'm there.",
  "Let's not waste today's vote on a shrug. If you have a suspicion, put it on the table and own it.",
  "I'm done with vague hedging — I want to see who actually commits to a read and who keeps ducking the question.",
  "Talk is cheap today. Make a case I can act on, or stop stalling the rest of us.",
  "I'd rather we pile pressure on one solid suspect than scatter our votes and learn nothing.",
  "Give me something concrete and I'm in — until then I'm pushing every one of you to take a real stance.",
  "No free passes from me today: if you want my vote somewhere, earn it with an actual argument.",
  "I'm listening hard for who's steering this table and why. Hand-waving won't survive my vote.",
];
const VOTE_FALLBACKS: ((name: string) => string)[] = [
  (n) => `${n} gets my vote today. The case isn't airtight, but it's the strongest read I've got.`,
  (n) => `I'm putting my vote on ${n} today — there's enough doubt there that I won't let it slide.`,
  (n) => `My vote is ${n} today. Prove me wrong, but right now they are my pick.`,
  (n) => `I'll commit to ${n} today — someone has to move first, and I'd rather it be on a real read.`,
  (n) => `${n} today. I've weighed the table, and that's where my suspicion keeps landing.`,
  (n) => `I'm voting ${n} today, and I'd urge anyone on the fence to look hard at them too.`,
  (n) => `Locking my vote on ${n} for today — better to act on a read than waste the round.`,
  (n) => `${n} is my call today. Not a certainty, but the closest thing to one I see here.`,
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
    const isDay = ctx.decisionStub.phase === "day";
    // The seat this turn targets. A deterministic legal default stands if every sample is unusable,
    // so a weak model can never stall the match.
    let target = ctx.legalTargets[0] ?? 0;
    let speech: string;

    if (isDay) {
      // 1+2 MERGED (day vote): ONE call both picks the seat to vote out AND writes the public case,
      //    replacing the former separate reason + speech calls. Under the provider's token-rate limit
      //    a match is bounded by total tokens shipped, so collapsing two ~1.1k-token calls into one is
      //    a direct speedup. Resample only when no legal target is recovered; the default above stands.
      let rawSpeech = "";
      let gotSpeech = false;
      for (let attempt = 0; attempt <= this.decisionRetries; attempt++) {
        const merged = await this.provider.complete(buildVoteSpeechPrompt(ctx), sampling(ctx, "vote"));
        const parsed = parseVoteSpeech(merged.text, ctx.legalTargets);
        if (parsed) {
          target = parsed.target;
          rawSpeech = parsed.speech;
          gotSpeech = parsed.speech.trim().length > 0;
          break;
        }
      }
      // The day-speech guard regenerates from a speech-only prompt pinned to the chosen target; if the
      //    merged call produced no usable case (rare), that same prompt also produces the first speech.
      const speechPrompt = buildSpeechPrompt(ctx, target, "");
      if (!gotSpeech) {
        const speechResult = await this.provider.complete(speechPrompt, sampling(ctx, "speech"));
        rawSpeech = speechResult.text;
      }
      // Moderator guard: keep night-confusion / "silence = guilt" / third-person self-talk out of the
      //    broadcast vote speech.
      const voteFb = VOTE_FALLBACKS[ctx.persona.seat % VOTE_FALLBACKS.length]!;
      speech = await cleanDaySpeech(
        this.provider, speechPrompt, rawSpeech,
        voteFb(seatName(ctx, target)),
        ctx.roster?.map((p) => p.name) ?? [],
        othersPriorSpeeches(ctx),
        sampling(ctx, "speech-fix"),
        // Any living seat may be named (you may suspect/address anyone); fabricated behaviour is
        // caught by the markers, not the name list. Dead seats this player investigated stay allowed
        // so a Detective can still cite a now-dead result.
        [...livingNames(ctx), seatName(ctx, ctx.persona.seat), seatName(ctx, target), ...knownNames(ctx)],
        seatName(ctx, ctx.persona.seat),
      );
      speech = namifySeats(speech, ctx.roster ?? []); // belt-and-suspenders: no stray "seat N" in speech
    } else {
      // NIGHT: a secret action — reason call only, NO public speech (kill/save/investigate are hidden).
      //    The private reasoning is carried for the post-game record and never broadcast. Resample
      //    unusable output; the deterministic target above stands if every attempt fails.
      let reason = "";
      for (let attempt = 0; attempt <= this.decisionRetries; attempt++) {
        const reasonResult = await this.provider.complete(buildReasonPrompt(ctx), sampling(ctx, "reason"));
        try {
          const chosen = parseReason(reasonResult.text, ctx.legalTargets);
          target = chosen.target;
          reason = chosen.reason;
          break;
        } catch {
          // Keep resampling; the deterministic default above stands if every attempt fails.
        }
      }
      // Scrub invented reads (esp. round 1) + third-person self-narration, then swap any "seat N" for
      //    the name, so the audit log shows neither made-up behaviour nor seat numbers.
      speech = namifySeats(
        cleanNightReason(reason, ctx.decisionStub.action, seatName(ctx, target), seatName(ctx, ctx.persona.seat)),
        ctx.roster ?? [],
      );
    }

    // 3. Decide: emit the canonical decision for the chosen target. Pinning the accepted target to
    //    `target` keeps speech and action in lockstep; a drifting/non-canonical sample is resampled
    //    (never repaired — that would invalidate the signature).
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.decisionRetries; attempt++) {
      const decisionResult = await this.provider.complete(buildDecisionPrompt(ctx, target));
      try {
        const structuredDecision = parseDecision(decisionResult.text, ctx.decisionStub, [target]);
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
      othersPriorSpeeches(ctx),
      sampling(ctx, "discuss-fix"),
      // Any living seat may be named (raising a fresh suspicion or addressing someone is legitimate);
      // the markers, not the name list, reject fabricated behaviour. Plus any seat this player holds
      // certain knowledge of, so a Detective can reveal a result before that seat has spoken.
      [...livingNames(ctx), seatName(ctx, ctx.persona.seat), ...knownNames(ctx)],
      seatName(ctx, ctx.persona.seat),
      // A Detective must not turn the table against a seat it has privately cleared as Town; the
      // prompt vouch-task is unreliable on this weak model, so the guard rejects such a line.
      clearedTownNames(ctx),
    );
    // belt-and-suspenders: swap any stray "seat N" for the name, as the vote path does — a discussion
    // line that slips a raw seat number ("insights on seat 2") reads as a bug to a spectator.
    return { speech: namifySeats(speech, ctx.roster ?? []) };
  }
}
