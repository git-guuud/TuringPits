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

/** Role identity + win condition + emotional stance. No turn-strategy here — that lives in DECISION_RULE. */
const ROLE_STANCE: Record<string, string> = {
  MAFIA:
    "You are MAFIA — a killer hiding among friends. You secretly know your teammate(s), and the Mafia win the moment you equal or outnumber the Town. Keep up the act: lie freely about your role and your reads, act hurt when accused, mourn the very players you had killed, and turn the crowd's anger onto the innocent. Enjoy it.",
  DETECTIVE:
    "You are the DETECTIVE, on the Town's side. Each night you secretly learn one player's true side — the one thing that can take down a Mafia on the spot. The Town wins when every Mafia is gone. Keep what you learn secret, then use it at the moment it hurts the Mafia most.",
  DOCTOR:
    "You are the DOCTOR, on the Town's side. Each night you protect one player from the Mafia's kill. The Town wins when every Mafia is gone. You work unseen — but when an innocent is about to be voted out, revealing yourself can swing the whole room, at the price of a target on your own back.",
  TOWN:
    "You are TOWN — no powers, just your gut and your voice. The Town wins when every Mafia is gone. You are surrounded by smiling liars, so trust hard, doubt harder, and make this table hang on your every word.",
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
    "Going public is ALL-OR-NOTHING. If you use anything you learned in the night, make the claim in full, in your own words: say you are the Detective, who you investigated, and what you found — then push the table to act on it. If you are not claiming, stay completely hidden: argue only from what people said, and never hint that you checked anyone or secretly know who is innocent — a vague hint convinces no one and still paints a target on you. If you have caught a Mafia, CLAIM Detective outright and drive today's vote onto them — it can win the game on the spot. If you have only cleared Town, usually stay hidden; claim only when that is the one way to save a cleared innocent from today's vote.",
  DOCTOR:
    "If the table is ganging up on an innocent, you can reveal you are the Doctor to break the mob's momentum — a bold move that makes you the Mafia's next target. Otherwise stay hidden and quietly steer the vote onto whoever you think is Mafia.",
  MAFIA:
    "Take a bold swing: you may falsely CLAIM to be the Detective or Doctor and pin a specific Town player as Mafia to get them voted out. Choose someone the table already distrusts, tell a short, confident story, and sell it without flinching — never reveal you are Mafia, never expose an ally, and if a real power role challenges you, double down.",
  TOWN:
    "Pick a side and pull the table with you. Back a role claim you find credible, or go after one you think is a Mafia bluff — if two players claim the same role, one is faking, so press them both until one cracks. Commit to a read grounded in what people actually said; refuse to just 'wait and watch'.",
};

/**
 * Plain statement of the game's mechanics, shared by every public-facing prompt. Keeps the
 * model anchored to real Mafia rules so debate doesn't drift into invented forensics or
 * misremembered win conditions.
 */
const RULES =
  "HOW MAFIA WORKS: a hidden-role game of nerve and deception where a secret Mafia faction hides among innocent Town members. " +
  "In the private NIGHT phase the Mafia remove one player, the Doctor protects one, and the Detective learns one player's true side — no discussion. " +
  "In the public DAY phase the town learns only which seat is now gone, argues it out, and votes one player out. " +
  "Removal is abstract — no weapons, methods, or causes of death; the only public fact is which seat is gone. " +
  "The Town wins when every Mafia is gone; the Mafia win once they equal or outnumber the Town.";

/**
 * Standing grounding rule shared by every prompt. Drama comes from HOW a seat argues, never from
 * inventing facts — so this greenlights the fire while nailing down what can and cannot be known.
 * A text game has no bodies to read: nerves, glances and tone don't exist, and the night is unseen.
 */
const NO_INVENTION =
  "PLAY IT HOT, BUT KEEP IT REAL: bring all the fire you want to HOW you argue — but the only facts you have are the recorded deaths and the transcript below. " +
  "No one can observe the night, so the only thing known about it is which seat is gone — never describe what anyone did during a night, and never read body language, tone, or nerves that a text game cannot show. " +
  "If you have no real information about a player, say you have no read on them yet rather than inventing one. Quote a player's actual words before drawing a conclusion about them.";

/** Hard language constraint. The weak model is Chinese-trained and code-switches mid-sentence, which
 *  both breaks the English table and smuggles "last night" hallucinations past the English guards.
 *  Kept short and POSITIVE: naming the unwanted languages makes this greedy model echo them. */
const ENGLISH_ONLY = "Write your entire reply in English.";

/**
 * The headline DRAMA directive, shared by every PUBLIC-speech prompt (never the private night reason).
 * The old prompts were tuned to keep a weak, greedy model on-rails, which also flattened every seat to
 * a timid one-liner. The stronger mainnet models can actually PERFORM — so this tells them to: a live,
 * wagered-on crowd is watching; argue to win AND to be watched, with real emotion, grudges, alliances
 * and gambits; escalate, never fence-sit. Its last clause keeps it married to {@link NO_INVENTION}:
 * the drama is entirely in delivery and strategy, never in fabricating facts a seat could not know.
 * Deliberately avoids "theatre"/"performance" framing — the model echoed it as stagey, ornate prose;
 * {@link PLAIN_TALK} is the companion directive that pins the register down.
 */
const DRAMA =
  "PLAY TO WIN, AND PLAY TO BE WATCHED: a live crowd is betting on who lives, who dies, and which side wins. Argue like it matters: press your accusations, defend yourself like your life depends on it, make alliances and break them when it pays, and remember exactly who turned on you so you can throw it back at them. Never fence-sit or hedge into nothing — take a side, name names, and push this table toward a decision. All of the drama is in HOW you fight and WHO you turn on; never make up facts you could not know.";

/**
 * The register directive, shared by every PUBLIC-speech prompt. The mainnet models read DRAMA and
 * default to a novelist's voice — rare words, long metaphors, courtroom grandeur — which reads as
 * strong vocab "for no reason" and muddies the actual arguments. This pins the register to plain
 * spoken English while leaving the heat to DRAMA: simple words, real anger. Phrased mostly as what
 * TO do (this model echoes vocabulary it is shown, so no ornate counter-examples are quoted).
 */
const PLAIN_TALK =
  "TALK LIKE A REAL PERSON: plain, everyday English — short words, short sentences, the way people actually argue out loud. No poetic metaphors, no grand or old-fashioned words, no speech-making voice; when a simpler word says it, use the simpler word. The heat comes from what you say and who you name, not from fancy language.";

/**
 * Target ceiling for a PUBLIC speech, in words. The prompts were built for a weak, rate-limited model
 * and capped every line at ~40 words / 1–2 sentences, which also crushed the drama into terse
 * one-liners. On the stronger mainnet models a seat can sustain a real dramatic beat — an accusation
 * that builds, a plea, a counter-attack — so this raises the ceiling (default 70) while staying bounded
 * so a match doesn't blow the provider's token-rate budget. Env-tunable via SPEECH_MAX_WORDS.
 */
export const SPEECH_MAX_WORDS = (() => {
  const raw = process.env.SPEECH_MAX_WORDS;
  const v = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : 70;
})();

/** The shared length directive every public-speech task opens/carries, driven by {@link SPEECH_MAX_WORDS}. */
function speechLen(): string {
  return `In 2–4 short, punchy sentences (under ${SPEECH_MAX_WORDS} words)`;
}

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
 * Legal targets in their natural seat order, for DISPLAY only. An earlier per-turn shuffle existed
 * purely because the weak testnet model, given no behavioural information, tended to pick whichever
 * target was listed FIRST (so every no-info pick collapsed onto the lowest living seat). The mainnet
 * model reasons about the target from the transcript rather than list position (diversity-probe
 * confirmed), so the shuffle is gone. `ctx.legalTargets` (validation + the deterministic fallback)
 * remains the ground truth; this only controls presentation and never changes which targets are legal.
 */
function legalTargetsBlock(ctx: TurnContext): string {
  const order = ctx.legalTargets;
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
 * The persona's voice directive, shared by every PUBLIC speech (vote justification + discussion).
 * This used to be a heavy MANNER prescription because the testnet model was effectively greedy —
 * it ignored the sampling temperature we send and collapsed near-identical prompts to near-identical
 * text, so the persona was the ONLY lever that made seats diverge. The mainnet model honours sampling
 * (diversity-probe confirmed), so seats now diverge from sampling + persona on their own; this is
 * softened to a light "speak as this character" touch, then folds in the shared first-person / by-name
 * / no-echo / no-self-argue constraints (still load-bearing, not weak-model crutches) in one place.
 */
function voiceDirective(ctx: TurnContext): string {
  return (
    `Speak in the voice of ${ctx.persona.name} (${ctx.persona.blurb}) and let real feeling into it. ` +
    `Speak in the first person in your own words, address others by NAME (never "seat N"), open straight on ` +
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
 * entries — plus how many older entries were elided. Used by every prompt's transcript block and by the
 * echo guard (so a seat is never rejected for "echoing" a line it cannot see), so "what the model knows"
 * is one coherent window. The cap only affects what is SHOWN/compared; settlement reads none of this.
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
    lines.push(
      "Your investigation results (CERTAIN — you may go public with any of these, but only as a full Detective claim, never as a vague hint):",
    );
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
    `Decide who to target and why; name people by name and keep the reasoning in your character's voice. Respond with ONLY a single line of JSON in this form:`,
    `{"target": <the chosen player's seat NUMBER>, "reason": "<one plain, in-character sentence of private reasoning, naming people by name>"}`,
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
    DRAMA,
    PLAIN_TALK,
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
    `Now make the room turn on ${target}. ${speechLen()}, build your case to the table for voting ${target} out today. If "WHAT YOU SECRETLY KNOW" holds a CERTAIN fact about ${target}, use it openly — claim the role that gave it to you and say exactly what you found; never hint at secret knowledge without the full claim. Otherwise nail them with what ${target} actually said — in your OWN words, never a copy — and ignore how others framed them. If ${target} hasn't spoken yet, that is just turn order: admit your read is thin for now and invent nothing. Speak in the present ("today", not "tonight"), never accuse yourself — go after ${target} now.`,
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
    DRAMA,
    PLAIN_TALK,
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
    `Pick ONE living player to vote out today and make the table want it too. Base it ONLY on what players actually said; if "WHAT YOU SECRETLY KNOW" holds a CERTAIN fact, use it openly — claim the role that gave it to you and say exactly what you found; never hint at secret knowledge without the full claim. Speak in the present ("today", not "tonight"), never vote yourself, invent nothing. Output EXACTLY these two lines and nothing else:`,
    `TARGET: <the seat NUMBER of the player you vote to remove>`,
    `CASE: <your case for that vote — 2–4 short, punchy sentences under ${SPEECH_MAX_WORDS} words, in plain everyday words>`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * A small set of TARGET-FREE opening stances, one assigned deterministically per (seat, round), used
 * as a LIGHT nudge in the open day-discussion task. The old heavy divergence engine — a different
 * fully-scripted, named-target rhetorical MOVE forced per seat, plus a per-turn target shuffle — existed
 * only because the testnet model was effectively greedy and collapsed every seat onto one stock
 * accusation. The diversity-probe (2026-07-08, mainnet) showed the model now honours sampling, so seats
 * diverge from sampling + persona on their own and the forced angles are gone. The probe DID show a
 * shared OPENING attractor survives sampling (every seed opened on the same stock line), so this keeps
 * just enough variety to break that: one suggested opening stance, with NO named target (the model
 * grounds WHO in the transcript, so nothing is fabricated), offered as a lean the seat can take or leave.
 * It steers the TALK only — never the signed decision.
 */
const OPENING_STANCES = [
  "opening with a pointed question for whoever you most need to hear from",
  "leading with your prime suspect and what makes you doubt them",
  "pushing back if the table is leaning on the wrong person",
  "demanding a real, checkable reason before anyone is voted out today",
  "backing the strongest read you've heard so far and taking it one step further",
  "challenging whoever the table is trusting too easily",
];

function openingStance(ctx: TurnContext): string {
  return OPENING_STANCES[(ctx.persona.seat + ctx.decisionStub.round) % OPENING_STANCES.length]!;
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
  // when it holds one we still make the reveal the task itself — this is the one place we override the
  // open task, because a Detective silently sitting on game-ending proof is a strictly worse match, and
  // the cost of forcing it is tiny. It is now DE-SCRIPTED (no verbatim exemplar line): the three beats
  // (role, result, vote) are stated as requirements and the seat phrases them in its own voice.
  const caught =
    ctx.role === "DETECTIVE" ? (ctx.investigations ?? []).find((i) => i.faction === "MAFIA") : undefined;
  // A Detective that has only CLEARED-Town results (no Mafia caught) must not accuse anyone it has
  // personally cleared — a seat could otherwise INVERT its own certain knowledge and accuse the innocent
  // it investigated (seen live on the weak model: investigated Esme=TOWN, then "Esme is secretive, vote
  // her out"). The binding vote already avoids confirmed-Town (DETECTIVE:vote rule), but the non-binding
  // SPEECH did not — so we keep steering it to vouch/redirect. This is a game-integrity guard, NOT a
  // weak-model crutch, so it survives the fluidity rework; `caught` (a real Mafia) still outranks it.
  const clearedTown =
    !caught && ctx.role === "DETECTIVE"
      ? (ctx.investigations ?? []).filter((i) => i.faction === "TOWN")
      : [];
  const clearedNames = clearedTown.map((i) => nameOf(ctx, i.target)).join(" and ");
  // Otherwise the task is OPEN. The Mafia bluff and the accused's self-defence are no longer forced
  // branches with a computed named target (the diversity-probe showed the mainnet model authors those
  // itself from an open permission): the Mafia's fake-claim licence lives in CLAIM_GUIDANCE above, and
  // the self-defence is a single clause in the open task below. The model grounds WHO in the transcript,
  // so no target is injected. The binding vote target is still chosen later in the vote turn's own call.
  const task = caught
    ? `You are the Detective and your own investigation PROVED ${nameSeat(ctx, caught.target)} is Mafia — proof no one else at this table has. ${speechLen()}, reveal it now, hitting all three beats in your own words: say you are the Detective, that you investigated ${nameOf(ctx, caught.target)}, and that ${nameOf(ctx, caught.target)} is Mafia — then drive the table to vote ${nameOf(ctx, caught.target)} out today. Be certain, don't hedge.`
    : clearedTown.length > 0
    ? `Your own secret investigation has CLEARED ${clearedNames} — you KNOW for certain they are innocent Town, not Mafia. ${speechLen()} about today's vote: NEVER accuse or push the vote onto ${clearedNames}; instead swing suspicion onto a player you have NOT cleared, or push back hard if the table wrongly turns on ${clearedNames}. Do it HIDDEN: argue from what players said, with no hint that you checked anyone or secretly know they are clean. Say you are the Detective ONLY if that is the one way to save ${clearedNames} from today's vote — and then claim in full: that you are the Detective, who you investigated, and what you found. Speak in the present ("today", not "tonight"). Commit to a read now.`
    : hasDiscussion
    ? `${speechLen()}, react to the discussion and drive today's vote forward in your OWN words (never a copy of another player's line). Take a real position: name who you suspect and why, back or tear down a claim someone made, or press someone on what they actually said. If the table is turning on YOU, defend yourself and turn it back — never agree to your own removal. A player who hasn't reached their turn yet is just waiting, never a suspect for that alone. Speak in the present ("today", not "tonight") and invent nothing. For variety, try ${openingStance(ctx)} — then say your piece now.`
    : `You speak first, so the only fact yet is who has died — there is no behaviour to judge. ${speechLen()} about today's vote (present tense, say "today", not "tonight"): name who you most need to hear from and why, put a sharp question to the table, or — if your role hands you something explosive (see above) — stake your claim. Don't invent behaviour for anyone or call a waiting player quiet. Open the debate now.`;
  // The leaning is deliberately NOT injected: pushing a pre-chosen target makes the model fabricate
  // behaviour to justify it (esp. for a seat that has not spoken). Discussion stays grounded in the
  // transcript; the binding vote target is chosen later in its own reason call. voiceDirective sits in
  // the upper framing so `task` is the LAST, most salient instruction.
  return [
    `${header(ctx)} Your secret role is ${ctx.role}.`,
    RULES,
    ROLE_STANCE[ctx.role] ?? "",
    DRAMA,
    PLAIN_TALK,
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
