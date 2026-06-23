import type { Decision } from "@turingpits/engine";
import { encodeDecision } from "@turingpits/engine";
import type { TurnContext } from "./types.js";

/** The action each role performs, phrased for the model. */
const ACTION_VERB: Record<string, string> = {
  kill: "secretly kill",
  save: "protect from the Mafia's kill",
  investigate: "investigate the alignment of",
  vote: "vote today to remove",
};

/** Role identity + win condition. No strategy here — that lives in DECISION_RULE. */
const ROLE_STANCE: Record<string, string> = {
  MAFIA:
    "You are MAFIA. You secretly know your teammate(s). Mafia win when you equal or outnumber the Town. Blend in, and you may lie freely about your role and your reads.",
  DETECTIVE:
    "You are the DETECTIVE, on the Town's side. Each night you secretly learn one player's true alignment. The Town wins when every Mafia is eliminated.",
  DOCTOR:
    "You are the DOCTOR, on the Town's side. Each night you protect one player from the Mafia's kill. The Town wins when every Mafia is eliminated.",
  TOWN:
    "You are an ordinary TOWN member with no special powers. The Town wins when every Mafia is eliminated.",
};

/** Action-specific heuristic, looked up as `${role}:${action}` then falling back to `${action}`. */
const DECISION_RULE: Record<string, string> = {
  "DETECTIVE:investigate":
    "Choose a seat whose alignment you have NOT yet learned. Never investigate a seat you already know.",
  "DETECTIVE:vote":
    "You hold hard knowledge from your investigations. NEVER vote a seat you have confirmed TOWN. If you have confirmed a Mafia, drive the table's vote onto them; otherwise vote the most suspicious seat you have not yet cleared.",
  "DOCTOR:save":
    "Reason about who the Mafia most wants dead this round — confident Town voices, and anyone who has claimed a power role — NOT who seems guilty. Guarding yourself is allowed but predictable.",
  "MAFIA:kill":
    "Remove the biggest threat to your team — confident Town voices, and anyone who has claimed Detective or Doctor. Never target a teammate.",
  "MAFIA:vote":
    "Usually steer the vote onto a Town target, or whoever threatens your team. You MAY vote a teammate when deliberately sacrificing them buys the table's trust — but never turn on an ally by accident, and keep your vote consistent with what you argued in the discussion.",
  vote:
    "You have no secret alignment information. Base your pick ONLY on what players actually said and how they voted, and treat every role claim as a claim, not proof. If no one has given you a real reason to suspect them yet, pick provisionally and let your reason say you have no firm read.",
};

function decisionRule(role: string, action: string): string {
  return DECISION_RULE[`${role}:${action}`] ?? DECISION_RULE[action] ?? "";
}

/**
 * How a player should USE its role in public talk (speech + discussion). Written as active plays,
 * not passive permission: the weak model defaults to bland fence-sitting unless a concrete, bold
 * move is put in front of it. These are what make a match dramatic — a Detective reveal, a Mafia
 * counter-claim — so they are phrased to be taken, while still leaving the timing to the agent.
 */
const CLAIM_GUIDANCE: Record<string, string> = {
  DETECTIVE:
    "Your knowledge is your weapon. If you have caught a Mafia, CLAIM Detective: name them, say you investigated them, and drive the table to vote them out — it paints a target on you but can win outright. If you have only cleared Town, vouch for them or stay hidden one more round. Pick one and commit; do not sit on certain knowledge.",
  DOCTOR:
    "If a clearly-innocent player is being railroaded, you can reveal you are the Doctor to break the momentum — but it makes you the Mafia's next target. Otherwise stay hidden and nudge the vote toward who you read as Mafia.",
  MAFIA:
    "Seize the initiative: you may falsely CLAIM to be the Detective or Doctor and pin a specific Town player as Mafia to get them voted out. Pick someone the table already distrusts, give a short concrete story, and commit fully — never reveal you are Mafia or that you know anyone's role.",
  TOWN:
    "Take a side and drive the vote. Back a role claim you find credible, or challenge one you think is a Mafia bluff — if two players claim the same role, one is faking, so press them. Commit to a read based on what people actually said; do not just say you will wait and watch.",
};

/**
 * Plain statement of the game's mechanics, shared by every public-facing prompt. Keeps the
 * model anchored to real Mafia rules so debate doesn't drift into invented forensics or
 * misremembered win conditions.
 */
const RULES =
  "HOW MAFIA WORKS: a hidden-role game where a secret Mafia faction hides among innocent Town members. " +
  "In the private NIGHT phase the Mafia remove one player, the Doctor protects one, and the Detective learns one player's true side — no discussion. " +
  "In the public DAY phase the town learns only which seat is now gone, talks it over, and votes one player out. " +
  "Removal is abstract — no weapons, methods, or causes of death; the only public fact is which seat is gone. " +
  "The Town wins when every Mafia is gone; the Mafia win once they equal or outnumber the Town.";

/** Standing anti-hallucination rule shared by every prompt. Kept short and positive: weak models echo back any "bad" words it names, so it states what IS known rather than listing what to avoid. */
const NO_INVENTION =
  "STAY GROUNDED: the only things you know are the recorded deaths and the transcript below. " +
  "No one can observe the night, so the only thing known about it is which seat is gone — never describe what anyone did during a night. " +
  "If you have no real information about a player, say you have no read on them yet rather than guessing. Quote a player's actual words before drawing a conclusion about them.";

/** Hard language constraint. The weak model is Chinese-trained and code-switches mid-sentence, which
 *  both breaks the English table and smuggles "last night" hallucinations past the English guards.
 *  Kept short and POSITIVE: naming the unwanted languages makes this greedy model echo them. */
const ENGLISH_ONLY = "Write your entire reply in English.";

/** States the current phase plainly so the model never confuses day debate with secret night play. */
function phaseFraming(ctx: TurnContext): string {
  const round = ctx.decisionStub.round;
  if (ctx.decisionStub.phase === "night") {
    return (
      `It is the NIGHT phase of round ${round}. You act in private — no one sees or hears this, ` +
      `and there is no discussion.`
    );
  }
  return (
    `It is the DAY phase of round ${round}. The town talks openly, then holds TODAY'S vote to remove one player — ` +
    `call it "today's vote". No one saw the night that just passed, so the only thing known about it is which seat is now gone.`
  );
}

/** The public record of who has died and how — the only ground truth about prior rounds. */
function eventsBlock(ctx: TurnContext): string {
  if (!ctx.deaths || ctx.deaths.length === 0) return "";
  const lines = ctx.deaths.map((d) =>
    d.phase === "night"
      ? `  round ${d.round}: seat ${d.seat} was killed by the Mafia during the previous night (killer unknown).`
      : `  round ${d.round}: seat ${d.seat} was voted out by the town.`,
  );
  return ["WHAT HAS HAPPENED (public record — these are the ONLY facts about prior rounds):", ...lines].join("\n");
}

/** This seat's display name (its persona name), used so players address each other by name. */
function nameOf(ctx: TurnContext, seat: number): string {
  const p = ctx.roster?.find((r) => r.seat === seat);
  return p ? p.name : `seat ${seat}`;
}

/** "Ada" → "Ada (seat 0)" so the model can map a spoken name back to the seat number a decision needs. */
function nameSeat(ctx: TurnContext, seat: number): string {
  const p = ctx.roster?.find((r) => r.seat === seat);
  return p ? `${p.name} (seat ${seat})` : `seat ${seat}`;
}

/** The cast list mapping each living player's name to its seat, so speech can use names. */
function rosterBlock(ctx: TurnContext): string {
  if (!ctx.roster || ctx.roster.length === 0) return "";
  const living = new Set(ctx.alive);
  const names = ctx.roster
    .filter((p) => living.has(p.seat))
    .map((p) => `${p.name} (seat ${p.seat})${p.seat === ctx.persona.seat ? " — you" : ""}`)
    .join(", ");
  return `Players still in the game: ${names}. Refer to people by NAME (e.g. ${ctx.roster[0]!.name}), never as "seat N".`;
}

/** The cast list (names) when a roster is present, else the bare living-seat list. */
function livingBlock(ctx: TurnContext): string {
  return rosterBlock(ctx) || `Living seats: ${ctx.alive.join(", ")}.`;
}

/**
 * Legal targets in a DETERMINISTIC per-turn shuffled order for DISPLAY only. The weak model, given no
 * behavioural information (e.g. every night-1 action), tends to pick whichever target is listed FIRST
 * — so a fixed seat-order list made every such pick gravitate to the lowest living seat (seat 0 always
 * died first; the Detective always burned night 1 investigating the seat about to be killed). Varying
 * the presentation order per (seat, round, phase, action) spreads those no-info picks across seats.
 * The underlying `ctx.legalTargets` (validation + the deterministic fallback) is untouched, and an
 * informed pick is driven by the transcript, not list order, so this only adds variety where there is
 * otherwise none — it never changes which targets are legal or how a decision is verified.
 */
function displayOrder(ctx: TurnContext): number[] {
  const arr = [...ctx.legalTargets];
  const d = ctx.decisionStub;
  const key = `${d.nonce}:${d.player}:${d.round}:${d.phase}:${d.action}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  let s = (h >>> 0) || 1;
  const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/** Legal targets as names+seats (the JSON still needs the seat number), or bare seats with no roster. */
function legalTargetsBlock(ctx: TurnContext): string {
  const order = displayOrder(ctx);
  if (ctx.roster && ctx.roster.length > 0) {
    return `Legal targets (in the JSON give the seat NUMBER): ${order.map((s) => nameSeat(ctx, s)).join(", ")}.`;
  }
  return `Legal target seats: ${order.join(", ")}.`;
}

function header(ctx: TurnContext): string {
  return (
    `You are playing the social-deduction game Mafia as ${ctx.persona.name} ` +
    `(${ctx.persona.blurb}), in seat ${ctx.persona.seat}.`
  );
}

/**
 * The persona's voice directive — the one forceful style instruction shared by every PUBLIC speech
 * (vote justification + discussion). The model is effectively greedy (it ignores the sampling
 * temperature we send) and collapses near-identical prompts to near-identical text, so the persona
 * is the ONLY lever that makes seats diverge. We make it prescriptive about MANNER (tone, rhythm,
 * sentence length, word choice) and demand the line read as instantly that character and never
 * generic, then fold in the shared first-person/by-name/no-echo constraints so they stay in one place.
 */
function voiceDirective(ctx: TurnContext): string {
  return (
    `Write entirely in the voice of ${ctx.persona.name} — ${ctx.persona.blurb}: let that personality ` +
    `drive your tone, rhythm and word choice so your line sounds instantly like that character, never generic. ` +
    `Speak in the first person in your own words, address others by NAME (never "seat N"), start straight into ` +
    `your point, do not prefix your line with a name label, do not echo another player's wording, and never ` +
    `argue against your own lines (marked "(you)").`
  );
}

/**
 * How many of the most recent transcript lines any prompt shows (and the echo guard compares against).
 * The transcript grows every day round, but past roughly one round the older lines add tokens without
 * adding live context — a power role's certain results live in {@link publicFactsBlock}, deaths in
 * {@link eventsBlock}, so only stale chatter is dropped. Under the provider's hard 2000 tokens/min cap
 * that bloat is the main reason later rounds crawl, so bounding the window keeps every prompt a roughly
 * constant size instead of growing each round. Tunable via `TRANSCRIPT_MAX_ENTRIES`; 0 or negative
 * disables the cap (show everything). Default 12 ≈ one full day round for a 6-seat table.
 */
export const TRANSCRIPT_MAX_ENTRIES = (() => {
  const raw = process.env.TRANSCRIPT_MAX_ENTRIES;
  if (raw === undefined || raw === "") return 12;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.trunc(v) : 12;
})();

/**
 * The recent slice of the transcript the model is shown — the last {@link TRANSCRIPT_MAX_ENTRIES}
 * entries — plus how many older entries were elided. Used by every prompt's transcript block, by the
 * echo guard (so a seat is never rejected for "echoing" a line it cannot see), and by the recent-
 * context task pickers ({@link underFire}/{@link frameTarget}), so "what the model knows" is one
 * coherent window. The cap only affects what is SHOWN/compared; settlement reads none of this.
 */
export function recentTranscript(ctx: TurnContext): {
  shown: readonly (readonly [number, string])[];
  elided: number;
} {
  const all = ctx.transcript;
  if (TRANSCRIPT_MAX_ENTRIES <= 0 || all.length <= TRANSCRIPT_MAX_ENTRIES) return { shown: all, elided: 0 };
  return { shown: all.slice(-TRANSCRIPT_MAX_ENTRIES), elided: all.length - TRANSCRIPT_MAX_ENTRIES };
}

function transcriptBlock(ctx: TurnContext): string {
  if (ctx.transcript.length === 0) {
    return "(no discussion yet — this is the start of the game. You have NO behavioral evidence about anyone, so do not reference anyone's past behavior, votes, or statements: none exist.)";
  }
  // A seat that has since been eliminated keeps its earlier lines in the record, but it is OUT of
  // the game and cannot be voted — tag it so the model reacts to the LIVING, never rallies a vote
  // against a corpse or treats a dead player's old accusation as a live thread.
  const living = new Set(ctx.alive);
  const { shown, elided } = recentTranscript(ctx);
  const lines = shown.map(([seat, text]) => {
    const tag = seat === ctx.persona.seat ? " (you)" : living.has(seat) ? "" : " (eliminated — cannot be voted)";
    return `  ${nameOf(ctx, seat)}${tag}: ${text}`;
  });
  // Note that older lines exist so the model doesn't mistake the window's start for the game's start
  // (which would wrongly suppress its reactions). Certain facts from earlier rounds survive in the
  // events/facts blocks; only stale discussion is omitted here.
  if (elided > 0) {
    lines.unshift(
      `  (… ${elided} earlier line${elided === 1 ? "" : "s"} from earlier rounds omitted — react to the recent lines below …)`,
    );
  }
  return lines.join("\n");
}

/** The "FACTS YOU KNOW" block, or "" when this seat knows nothing certain. */
function factsBlock(ctx: TurnContext): string {
  const lines: string[] = [];
  if (ctx.role === "MAFIA" && ctx.teammates && ctx.teammates.length > 0) {
    lines.push(
      `Your fellow Mafia: ${ctx.teammates.map((s) => `seat ${s}`).join(", ")}. They are on your team — never target them.`,
    );
  }
  if (ctx.role === "DETECTIVE" && ctx.investigations && ctx.investigations.length > 0) {
    lines.push("Your investigation results (these are CERTAIN):");
    for (const inv of ctx.investigations) {
      lines.push(`  round ${inv.round}: seat ${inv.target} is ${inv.faction}`);
    }
  }
  if (ctx.ownHistory && ctx.ownHistory.length > 0) {
    lines.push("Your own past moves:");
    for (const a of ctx.ownHistory) {
      lines.push(`  round ${a.round} ${a.phase}: ${a.action} seat ${a.target}`);
    }
  }
  return lines.length === 0 ? "" : ["FACTS YOU KNOW (certain — act on them):", ...lines].join("\n");
}

/**
 * The slice of private knowledge a seat may legitimately ACT ON in PUBLIC talk: a Detective's
 * certain findings (which it can choose to reveal to rally the Town) and, for Mafia, its secret
 * ally/allies (so it never throws one under the bus while bluffing). Deliberately OMITS a seat's
 * own night actions (kills/saves/investigation acts) — those must stay secret, so unlike
 * `factsBlock` this never lists `ownHistory`. Empty for an ordinary Town seat. Used only by the
 * public speech + discussion prompts so the agent has something concrete to claim or protect.
 */
function publicFactsBlock(ctx: TurnContext): string {
  const lines: string[] = [];
  if (ctx.role === "DETECTIVE" && ctx.investigations && ctx.investigations.length > 0) {
    lines.push("Your investigation results (CERTAIN — you may reveal any of these to the table if you choose):");
    for (const inv of ctx.investigations) lines.push(`  ${nameSeat(ctx, inv.target)} is ${inv.faction}`);
  }
  if (ctx.role === "MAFIA" && ctx.teammates && ctx.teammates.length > 0) {
    lines.push(
      `Your secret Mafia ally/allies: ${ctx.teammates.map((s) => nameSeat(ctx, s)).join(", ")}. ` +
        `NEVER reveal this and never knowingly accuse them — everyone else is fair game.`,
    );
  }
  return lines.length === 0 ? "" : ["WHAT YOU SECRETLY KNOW:", ...lines].join("\n");
}

/**
 * Reason prompt (call 1): the player privately picks a legal target, seeing role stance, its
 * decision rule, certain facts, info-state grounding, the public transcript, and legal targets.
 * Output parsed by `parseReason`; not load-bearing for settlement.
 */
export function buildReasonPrompt(ctx: TurnContext): string {
  const verb = ACTION_VERB[ctx.decisionStub.action] ?? ctx.decisionStub.action;
  const facts = factsBlock(ctx);
  const events = eventsBlock(ctx);
  const rule = decisionRule(ctx.role, ctx.decisionStub.action);
  return [
    header(ctx),
    RULES,
    ROLE_STANCE[ctx.role] ?? `Your secret role is ${ctx.role}.`,
    livingBlock(ctx),
    NO_INVENTION,
    ENGLISH_ONLY,
    ``,
    phaseFraming(ctx),
    ...(events ? [events, ``] : []),
    `Public discussion so far:`,
    transcriptBlock(ctx),
    ``,
    ...(facts ? [facts, ``] : []),
    `You must ${verb} one player.`,
    ...(rule ? [rule] : []),
    ...(ctx.decisionStub.phase === "night" && ctx.transcript.length === 0
      ? [
          "No one has spoken yet, so you have NO reads on anyone's behaviour — do not claim anyone is confident, vocal, quiet, suspicious, or has made any claim. Choose from role/persona priors and let your reason say plainly that it is an early move without behavioural evidence.",
        ]
      : []),
    legalTargetsBlock(ctx),
    ``,
    `Decide who to target and why; refer to people by name in your reason. Respond with ONLY a single line of JSON in this form:`,
    `{"target": <the chosen player's seat NUMBER>, "reason": "<one short sentence of in-character reasoning, naming people by name>"}`,
  ].join("\n");
}

/**
 * Speech prompt (call 2, DAY VOTE only): in-character justification of the already-chosen vote.
 * Anchored to this seat; given claim guidance so power roles can choose to reveal and Mafia can
 * bluff. Not load-bearing.
 */
export function buildSpeechPrompt(ctx: TurnContext, chosenTarget: number, reason: string): string {
  const verb = ACTION_VERB[ctx.decisionStub.action] ?? ctx.decisionStub.action;
  const events = eventsBlock(ctx);
  const target = nameOf(ctx, chosenTarget);
  // Shared framing comes first; the single vote directive is the LAST thing the model reads, so it
  // stays the most salient instruction (a weak model greedy-echoes whatever trails the prompt).
  return [
    `${header(ctx)} Your secret role is ${ctx.role}.`,
    RULES,
    ROLE_STANCE[ctx.role] ?? "",
    livingBlock(ctx),
    NO_INVENTION,
    ENGLISH_ONLY,
    CLAIM_GUIDANCE[ctx.role] ?? "",
    voiceDirective(ctx),
    publicFactsBlock(ctx),
    ``,
    phaseFraming(ctx),
    ...(events ? [events] : []),
    `Public discussion so far:`,
    transcriptBlock(ctx),
    ``,
    `You have privately decided to ${verb} ${target}. Your private reasoning: ${reason}`,
    `Now, in ONE or TWO sentences (under 40 words), make your case to the table for voting ${target} today. If "WHAT YOU SECRETLY KNOW" holds a CERTAIN fact about ${target}, state it and tell the table to follow you. Otherwise base it on what ${target} actually said — in your OWN words, never a copy — and ignore how others framed them. If ${target} hasn't spoken yet, that is just turn order: say your read is thin and provisional, and invent nothing. Speak in the present ("today", not "tonight"), never accuse yourself — make the case for ${target} now.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * MERGED day-vote prompt (call 1 of 2, replacing the separate reason + speech calls): the player
 * BOTH picks the seat to vote out AND makes its public case, in one inference. It carries the full
 * speech scaffolding (role stance, claim guidance, voice, public facts, transcript) plus the legal
 * targets and the vote heuristic, and asks for two labelled lines — `TARGET:` / `CASE:` — which a
 * weak model formats far more reliably than JSON around a long free-text field. Parsed by
 * {@link parseVoteSpeech}; NOT load-bearing (the signed decision is still produced separately and
 * pinned to the chosen target). Collapsing two ~1.1k-token calls into one is a direct token saving
 * under the provider's token-rate limit. Night turns keep {@link buildReasonPrompt} (no public speech).
 */
export function buildVoteSpeechPrompt(ctx: TurnContext): string {
  const events = eventsBlock(ctx);
  const rule = decisionRule(ctx.role, "vote");
  return [
    `${header(ctx)} Your secret role is ${ctx.role}.`,
    RULES,
    ROLE_STANCE[ctx.role] ?? "",
    livingBlock(ctx),
    NO_INVENTION,
    ENGLISH_ONLY,
    CLAIM_GUIDANCE[ctx.role] ?? "",
    voiceDirective(ctx),
    publicFactsBlock(ctx),
    ``,
    phaseFraming(ctx),
    ...(events ? [events] : []),
    `Public discussion so far:`,
    transcriptBlock(ctx),
    ``,
    ...(rule ? [rule] : []),
    legalTargetsBlock(ctx),
    `Pick ONE living player to vote out today and make your case for it. Base it ONLY on what players actually said; if "WHAT YOU SECRETLY KNOW" holds a CERTAIN fact, use it and tell the table to follow you. Speak in the present ("today", not "tonight"), never vote yourself, invent nothing. Output EXACTLY these two lines and nothing else:`,
    `TARGET: <the seat NUMBER of the player you vote to remove>`,
    `CASE: <your 1-2 sentence case to the table for that vote, under 40 words, in your own voice>`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * True when the table is actively turning on THIS seat — another player's line both names it AND
 * carries accusation/vote language. The weak model otherwise mis-reads "the table is discussing
 * Felix" (when it IS Felix) as a cue to agree and vote ITSELF out; flipping the task to a
 * first-person defence both stops that self-railroad and turns the moment into real drama (the
 * accused fighting back). A purely positive mention does not trip it — only suspicion aimed here.
 */
function underFire(ctx: TurnContext): boolean {
  const self = nameOf(ctx, ctx.persona.seat);
  if (!ctx.roster || self === `seat ${ctx.persona.seat}`) return false;
  const selfRe = new RegExp(`\\b${self.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  // Only count accusations the model can actually SEE (the recent window), so a self-defence task is
  // never triggered by an elided line the prompt no longer shows.
  return recentTranscript(ctx).shown.some(([s, t]) => s !== ctx.persona.seat && selfRe.test(t) && SUSPICION_RE.test(t));
}

/** Suspicion language: marks a line as aiming at a seat — used by {@link underFire} and {@link frameTarget}. */
const SUSPICION_RE =
  /\b(?:vote|suspect|suspicious|mafia|guilty|hiding|distrust|accuse|against|remove|eliminat|out)\b/i;

/**
 * A living non-teammate this Mafia can credibly frame with a fake Detective claim. Prefers, in order:
 * a seat that is actively ACCUSING this Mafia (framing your accuser is the most coherent bluff when
 * cornered — "I'm the Detective and MY accuser is the real Mafia"), then whoever the table is most
 * suspicious of (a frame it half-believes already), then anyone who has actually spoken, with the
 * per-turn shuffle as the final tie-break so the frame never just lands on the lowest seat. Returns
 * null when no eligible target exists (only teammates remain) or this seat is not Mafia.
 *
 * The weak model will FRAME a Town player via plain accusation but won't INVENT a structured role-claim
 * lie unprompted (see role-strategic-play memory). Handing the bluff task a concrete, named target turns
 * it from open-ended invention into a fill-in-the-template instruction — the lever that gets it to fire.
 */
function frameTarget(ctx: TurnContext): number | null {
  if (ctx.role !== "MAFIA") return null;
  const teammates = new Set(ctx.teammates ?? []);
  const self = ctx.persona.seat;
  const eligible = new Set(ctx.alive.filter((s) => s !== self && !teammates.has(s)));
  if (eligible.size === 0) return null;
  // Score from the recent window only, so the frame keys off suspicion the model can actually see.
  const tx = recentTranscript(ctx).shown;
  const spoke = new Set(tx.map(([s]) => s));
  const nameRe = (seat: number): RegExp =>
    new RegExp(`\\b${nameOf(ctx, seat).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const selfRe = nameRe(self);
  // A seat actively accusing US is the most coherent frame; otherwise weigh how much suspicion the
  // table has already aimed at the seat (a frame others half-believe). Accuser bonus dominates.
  const score = (seat: number): number => {
    const accusesUs = tx.some(([s, t]) => s === seat && selfRe.test(t) && SUSPICION_RE.test(t));
    const re = nameRe(seat);
    const suspected = tx.filter(([s, t]) => s !== seat && s !== self && re.test(t) && SUSPICION_RE.test(t)).length;
    return (accusesUs ? 100 : 0) + suspected;
  };
  return (
    displayOrder(ctx)
      .filter((s) => eligible.has(s))
      .sort((a, b) => score(b) - score(a) || (spoke.has(b) ? 1 : 0) - (spoke.has(a) ? 1 : 0))
      .at(0) ?? null
  );
}

/**
 * The living non-self seat the recent transcript aims the most suspicion at — the seat the table is
 * already turning on (null if no roster, no one has spoken, or no suspicion has been voiced). Read
 * off the SAME recent window the model is shown, so it never points at a seat whose accusing line has
 * been elided. Used by the per-seat discussion angles that hand a CONCRETE target to react to (accuse
 * the pile-on, or defend it), turning an open menu — which this greedy model collapses onto one stock
 * accusation — into a fill-in-the-name instruction.
 */
function mostSuspected(ctx: TurnContext): number | null {
  if (!ctx.roster) return null;
  const self = ctx.persona.seat;
  const tx = recentTranscript(ctx).shown;
  const nameRe = (seat: number): RegExp =>
    new RegExp(`\\b${nameOf(ctx, seat).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  let best: number | null = null;
  let bestScore = 0;
  for (const seat of ctx.alive) {
    if (seat === self) continue;
    const re = nameRe(seat);
    const score = tx.filter(([s, t]) => s !== seat && re.test(t) && SUSPICION_RE.test(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = seat;
    }
  }
  return best;
}

/**
 * Living non-self seats that have ALREADY spoken in the recent window, in the per-turn shuffled
 * display order (so different seats key off a different "first" peer rather than always the lowest
 * seat). The angle tasks that question / back a specific player draw their target from here, so the
 * named seat is always one the speaker can legitimately react to (it actually has a line on the table).
 */
function spokenPeers(ctx: TurnContext): number[] {
  if (!ctx.roster) return [];
  const self = ctx.persona.seat;
  const spoke = new Set(recentTranscript(ctx).shown.map(([s]) => s));
  return displayOrder(ctx).filter((s) => s !== self && spoke.has(s));
}

/**
 * How many distinct rhetorical angles {@link discussionAngle} rotates through. Set to the product seat
 * count (6) so that within a single round the `(seat + round)` assignment hands every living seat a
 * DIFFERENT angle — two seats never receive the same instruction at the same time, which is what stops
 * the greedy model collapsing the whole table onto one name-swapped accusation template.
 */
const ANGLE_COUNT = 6;

/**
 * The generic day-discussion task, specialised into one of {@link ANGLE_COUNT} distinct rhetorical
 * MOVES assigned deterministically per `(seat, round)`. The weak model is effectively greedy: given
 * the old single "take a side / name who you suspect" MENU it resolved EVERY seat to the same stock
 * accusation, name-swapped ("X's sudden shift feels suspicious — X is hiding something."). Handing
 * each seat a different concrete move — question, accuse, defend a pile-on, demand proof, build on a
 * peer, challenge the trusted — and, where the move needs one, a named target it can legitimately
 * react to ({@link spokenPeers} / {@link mostSuspected}, so nothing is invented), turns an open menu
 * into the fill-in-the-template instruction this model reliably follows, so seats diverge by CONTENT,
 * not just persona voice. Each line is SHORT, POSITIVE and ENDS on its action command (this model
 * latches onto whatever trails the prompt). Angles fall back to a name-free variant when no suitable
 * peer has spoken yet. The binding vote target is still chosen later in the vote turn's own call —
 * an angle steers the TALK, never the signed decision.
 */
function discussionAngle(ctx: TurnContext): string {
  const idx = (ctx.persona.seat + ctx.decisionStub.round) % ANGLE_COUNT;
  const peers = spokenPeers(ctx);
  const peer = peers.length > 0 ? nameOf(ctx, peers[0]!) : "";
  const heatSeat = mostSuspected(ctx);
  const heat = heatSeat !== null ? nameOf(ctx, heatSeat) : "";
  switch (idx) {
    case 0: // QUESTIONER — interrogate a specific peer, withhold your vote until answered
      return peer
        ? `Put ONE sharp, specific question to ${peer} about something ${peer} actually said above, and say you won't vote with ${peer} until you get a straight answer. Ask it now.`
        : `Open with a sharp question: name the ONE thing about today's vote you most need answered before you'll commit, and put it to the table. Ask it now.`;
    case 1: // ACCUSER — one blunt named suspect, grounded, no hedging
      return `Name your single prime suspect for today and back it by quoting the words of theirs that worry you most — no maybes, no hedging. State that accusation now.`;
    case 2: // DEFENDER / bandwagon-breaker — weigh the case against whoever is drawing heat
      return heat
        ? `${heat} is drawing the table's heat. Say plainly whether the case against ${heat} actually holds up — and if it's thin, call out the rush and point suspicion somewhere better. Take that stand now.`
        : `Push back on the loudest read at the table: say whether it is actually earned or just the easy answer, and where you would look instead. Make that case now.`;
    case 3: // EVIDENCE-DEMANDER — raise the bar, ask for a real reason before any vote
      return `Cut through the noise: say the talk so far is long on suspicion and short on proof, and demand that someone put a real, checkable reason on the table before this vote is spent. Set that bar now.`;
    case 4: // BUILDER — endorse a peer's point and push it one step toward a name
      return peer
        ? `${peer} made a point worth more than it got. Say you are with ${peer}, then carry that reasoning one step further, toward an actual name. Build on it now.`
        : `Lay down a concrete frame the table can build on: name what would actually make you trust or doubt someone today, then invite others onto it. Set it now.`;
    default: // CONTRARIAN — challenge the comfortable consensus / the most-trusted seat
      return `Go against the grain: name who this table seems to TRUST most right now and ask out loud whether that trust is earned or just comfortable. Press that now.`;
  }
}

/**
 * Discussion prompt (DAY discussion pass): free-form debate before the vote, grounded purely in
 * the public transcript. It pushes the debate forward — reacting to a named player and adding one
 * new point, optionally claiming/bluffing a role — but is deliberately NOT given a pre-chosen
 * target: pushing a leaning makes a weak model fabricate behaviour to justify it. The binding
 * vote target is chosen later in the vote turn's own reason call. Never produces a decision.
 */
export function buildDiscussionPrompt(ctx: TurnContext): string {
  const events = eventsBlock(ctx);
  const hasDiscussion = ctx.transcript.length > 0;
  // A Detective sitting on a CONFIRMED Mafia is the single most game-changing thing at the table, so
  // when it holds one we make the reveal the task itself — not an option buried in the role guidance
  // it kept declining to take. (The target is in `knownNames`, so the moderator guard allows naming
  // it even before it has spoken.) Town/Doctor/Mafia keep the open-ended bolder task below.
  const caught =
    ctx.role === "DETECTIVE" ? (ctx.investigations ?? []).find((i) => i.faction === "MAFIA") : undefined;
  // A seat under active suspicion defends itself (unless it is a Detective holding a caught Mafia —
  // then revealing IS its best defence, so `caught` wins). This both stops the self-railroad (the
  // model agreeing to vote ITSELF out) and makes the accused fight back, the heart of the drama.
  const fire = !caught && underFire(ctx);
  // A Detective that has only CLEARED-Town results (no Mafia caught) must not accuse anyone it has
  // personally cleared — the weak model otherwise INVERTS its own certain knowledge and accuses the
  // innocent it investigated (seen live: investigated Esme=TOWN, then "Esme is secretive, vote her
  // out", misleading the whole table). The binding vote already avoids confirmed-Town (DETECTIVE:vote
  // rule), but the non-binding SPEECH did not. So steer it to vouch/redirect. `caught` and self-
  // defence both outrank this (a real Mafia or its own survival come first).
  const clearedTown =
    !caught && !fire && ctx.role === "DETECTIVE"
      ? (ctx.investigations ?? []).filter((i) => i.faction === "TOWN")
      : [];
  const clearedNames = clearedTown.map((i) => nameOf(ctx, i.target)).join(" and ");
  // From round 2 on (a credible frame has had time to form), a Mafia is handed a bold fake-Detective
  // bluff as its TASK, aimed at a concrete non-teammate target. The weak model FRAMES via plain
  // accusation but won't author a structured role-claim lie unprompted (role-strategic-play memory) —
  // a named target turns the bluff into a fill-in-the-template instruction. This OUTRANKS self-defence:
  // a Mafia is usually under some suspicion by round 2, and claiming Detective (framing its accuser) is
  // a stronger, more watchable response than a generic rebuttal — otherwise the bluff would stay
  // dormant in real games. Never fires for a Town/Detective seat (frameTarget returns null).
  const frame =
    !caught && ctx.role === "MAFIA" && ctx.decisionStub.round >= 2 ? frameTarget(ctx) : null;
  // Each task is kept SHORT and, crucially, ENDS ON ITS ACTION COMMAND — never on the "today's
  // vote, not tonight" reminder, which this greedy model latches onto and echoes ("Today's vote,
  // please.") instead of playing. The phase framing already supplies the "today's vote" anchor.
  const task = caught
    ? `You are the Detective and your investigation PROVED ${nameSeat(ctx, caught.target)} is Mafia — proof no one else has. In your own voice, under 40 words, reveal it now and keep all three parts (your role, your result, the vote), like: "I am the Detective. I investigated ${nameOf(ctx, caught.target)} and ${nameOf(ctx, caught.target)} is Mafia — vote ${nameOf(ctx, caught.target)} out today." Be certain, no hedging.`
    : frame !== null
    ? `You are secretly Mafia — seize today's vote with a bold bluff. In your own voice, under 40 words, claim the Detective role now and keep all three parts (your role, your "result", the vote), like: "I am the Detective. I investigated ${nameOf(ctx, frame)} and ${nameOf(ctx, frame)} is Mafia — vote ${nameOf(ctx, frame)} out today." Never hint you are Mafia, never name an ally.`
    : fire
    ? `The table is turning on YOU — players above are pushing to vote you out. In 1-2 sentences (under 40 words), defend YOURSELF in the first person: rebut their reason using what was actually said, and turn the heat back onto whoever is pushing hardest or whose own case is weakest. Speak as "I"; never agree you are guilty, never vote for yourself, and invent nothing. Make your defence now.`
    : clearedTown.length > 0
    ? `Your own secret investigation has CLEARED ${clearedNames} — you KNOW for certain they are innocent Town, not Mafia. In 1-2 sentences (under 40 words) about today's vote: NEVER accuse or push the vote onto ${clearedNames}; instead steer suspicion toward a player you have NOT cleared, or push back if the table wrongly turns on ${clearedNames}. You need not reveal how you know. Speak in the present ("today", not "tonight"). Commit to a read now.`
    : hasDiscussion
    ? `In 1-2 sentences (under 40 words), in your OWN words and never a copy of another player's line — speak in the present ("today", not "tonight"), and a player who hasn't reached their turn yet is just waiting, never a suspect for that alone. Now do exactly this: ${discussionAngle(ctx)}`
    : `You speak first, so the only fact yet is who has died — there is no behaviour to judge. In 1-2 sentences (under 40 words) about today's vote (present tense, say "today", not "tonight"), open with intent: name who you most want to hear from and why, put a sharp question to the table, or — if your role hands you something concrete (see above) — stake your claim. Don't invent behaviour for anyone or call a waiting player quiet. Open the debate now.`;
  // The leaning is deliberately NOT injected: pushing a pre-chosen target makes a weak model
  // fabricate behaviour to justify it (esp. for a seat that has not spoken). Discussion stays
  // grounded in the transcript; the binding vote target is chosen later in its own reason call.
  // voiceDirective sits in the upper framing so `task` is the LAST, most salient instruction.
  return [
    `${header(ctx)} Your secret role is ${ctx.role}.`,
    RULES,
    ROLE_STANCE[ctx.role] ?? "",
    livingBlock(ctx),
    NO_INVENTION,
    ENGLISH_ONLY,
    CLAIM_GUIDANCE[ctx.role] ?? "",
    voiceDirective(ctx),
    publicFactsBlock(ctx),
    ``,
    phaseFraming(ctx),
    ...(events ? [events] : []),
    `Public discussion so far:`,
    transcriptBlock(ctx),
    ``,
    task,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Decision prompt (call 3): a constrained inference whose *entire* output must be the
 * canonical decision string. The skeleton is pinned to the seat chosen during reasoning, so
 * the model only needs to echo it verbatim. The exact output text is what the TEE signs and
 * what the Solidity verifier reconstructs — `Player.takeTurn` re-checks the target matches.
 */
export function buildDecisionPrompt(ctx: TurnContext, chosenTarget: number): string {
  const sample: Decision = { ...ctx.decisionStub, target: chosenTarget };
  const skeleton = encodeDecision(sample);
  // This is a transcription task, not a conversation: the model's ENTIRE output must equal
  // `skeleton` byte-for-byte (parseDecision re-checks with strict equality). We therefore frame
  // it as "copy this line exactly" and call out every drift mode a chat model tends to add —
  // code fences, spaces after `:`/`,`, a trailing newline, reordered keys, quoted numbers, prose.
  // The exact line is repeated last so it's the most recent thing the model sees before replying.
  return [
    `Transcription task. You record your ${ctx.decisionStub.action} on seat ${chosenTarget} as one line of JSON.`,
    `This is not a conversation — do not reply to it, only copy the line below.`,
    ``,
    `Copy this line EXACTLY, character for character — your entire response must equal it:`,
    skeleton,
    ``,
    `It must be byte-for-byte identical:`,
    `- keep the keys in this order: nonce, phase, round, player, action, target;`,
    `- keep target as the number ${chosenTarget} (not a string, not a different seat);`,
    `- numbers stay bare numbers; only the existing strings keep their double quotes;`,
    `- NO space after any ':' or ',', and NO space, quote, or newline before or after the object;`,
    `- NO code fences, NO backticks, NO markdown, NO prose, NO explanation — nothing but the line.`,
    ``,
    `Output only this, and nothing else:`,
    skeleton,
  ].join("\n");
}
