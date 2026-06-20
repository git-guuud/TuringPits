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
    "Steer the vote onto a Town target, or whoever threatens your team. Never vote a teammate.",
  vote:
    "You have no secret alignment information. Base your pick ONLY on what players actually said and how they voted, and treat every role claim as a claim, not proof. If no one has given you a real reason to suspect them yet, pick provisionally and let your reason say you have no firm read.",
};

function decisionRule(role: string, action: string): string {
  return DECISION_RULE[`${role}:${action}`] ?? DECISION_RULE[action] ?? "";
}

/** What a player may say about its own/others' roles during public talk (speech + discussion). */
const CLAIM_GUIDANCE: Record<string, string> = {
  DETECTIVE:
    "You MAY claim to be the Detective and reveal a finding to rally the Town — but it marks you as the Mafia's next target. Or stay hidden. Your call.",
  DOCTOR:
    "You MAY hint that you are the Doctor to coordinate protection — but it marks you as a target. Or stay hidden. Your call.",
  MAFIA:
    "You MAY falsely claim to be the Detective or Doctor to misdirect the Town and pin suspicion on an innocent — but a claim that unravels exposes you.",
  TOWN:
    "If a player claims a power role, weigh it skeptically — the Mafia fake roles too. Two players claiming the same role means at least one is faking.",
};

/**
 * Plain statement of the game's mechanics, shared by every public-facing prompt. Keeps the
 * model anchored to real Mafia rules so debate doesn't drift into invented forensics or
 * misremembered win conditions.
 */
const RULES =
  "HOW MAFIA WORKS: This is a hidden-role game. A secret Mafia faction hides among innocent Town members, and no one is told who the Mafia are. " +
  "The game alternates between two phases. In the secret NIGHT phase the Mafia pick one player to remove, the Doctor protects one player, and the Detective learns one player's true side — all in private, with no discussion. " +
  "In the public DAY phase the town finds out only WHICH seat is now gone, talks it over, and votes one player out. " +
  "Removal is abstract: there are no weapons, methods, or causes of death — the only public fact is which seat is gone. " +
  "The Town wins when every Mafia member is gone; the Mafia win once they equal or outnumber the Town.";

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
    `It is the DAY phase of round ${round}. The town is talking openly and will then hold TODAY'S vote to remove one player — ` +
    `the vote happens now, in daylight, so call it "today's vote". The transcript below is everything anyone has said. ` +
    `No one can see the night that just passed, so the only thing known about it is which seat is now gone.`
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

/** Legal targets as names+seats (the JSON still needs the seat number), or bare seats with no roster. */
function legalTargetsBlock(ctx: TurnContext): string {
  if (ctx.roster && ctx.roster.length > 0) {
    return `Legal targets (in the JSON give the seat NUMBER): ${ctx.legalTargets.map((s) => nameSeat(ctx, s)).join(", ")}.`;
  }
  return `Legal target seats: ${ctx.legalTargets.join(", ")}.`;
}

function header(ctx: TurnContext): string {
  return (
    `You are playing the social-deduction game Mafia as ${ctx.persona.name} ` +
    `(${ctx.persona.blurb}), in seat ${ctx.persona.seat}.`
  );
}

function transcriptBlock(ctx: TurnContext): string {
  if (ctx.transcript.length === 0) {
    return "(no discussion yet — this is the start of the game. You have NO behavioral evidence about anyone, so do not reference anyone's past behavior, votes, or statements: none exist.)";
  }
  return ctx.transcript
    .map(([seat, text]) => `  ${nameOf(ctx, seat)}${seat === ctx.persona.seat ? " (you)" : ""}: ${text}`)
    .join("\n");
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
  return [
    `${header(ctx)} Your secret role is ${ctx.role}.`,
    RULES,
    ROLE_STANCE[ctx.role] ?? "",
    livingBlock(ctx),
    NO_INVENTION,
    ENGLISH_ONLY,
    CLAIM_GUIDANCE[ctx.role] ?? "",
    ``,
    phaseFraming(ctx),
    ...(events ? [events] : []),
    `Public discussion so far:`,
    transcriptBlock(ctx),
    ``,
    `You have privately decided to ${verb} ${nameOf(ctx, chosenTarget)}. Your private reasoning: ${reason}`,
    `In ONE or TWO sentences (under 40 words), tell the table that your vote in today's vote is for ${nameOf(ctx, chosenTarget)}. Base your reason only on what ${nameOf(ctx, chosenTarget)} THEMSELVES said above — quote a few of their own real words if they support it. Ignore how other players have described ${nameOf(ctx, chosenTarget)}; do not repeat anyone else's characterisations of them. If ${nameOf(ctx, chosenTarget)} has not spoken, that is just turn order and is NOT evidence — do NOT call them silent, quiet, or hiding, and do NOT invent anything they said or did; say only that your read is thin and you are voting provisionally.`,
    `Stay in character as ${ctx.persona.name}, ${ctx.persona.blurb} — let that voice shape your wording so it sounds unlike anyone else. Speak as yourself in the first person, in the present tense about this daytime vote (say "today", not "tonight"). Address other players by NAME, never as "seat N", and do not prefix your line with a name label. Do not echo another player's wording, do not argue against your own lines (marked "(you)"), and never accuse yourself or reveal information that would hurt your faction.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
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
  const task = hasDiscussion
    ? `Add ONE short, fresh point to the debate (1-2 sentences, under 40 words). Respond BY NAME to another player whose line actually appears above — quote a few of their real words and say whether it makes you trust or suspect them. Players speak in turn, so anyone whose line is NOT above is simply waiting for their turn: that is completely normal and means nothing, so you must NEVER call a player quiet, silent, withdrawn, or suspicious for not having spoken, and never invent words or behaviour for someone whose line is not above. Call the vote "today's vote", never "tonight". Stay in character as ${ctx.persona.name}, ${ctx.persona.blurb} — let that voice make your wording unlike anyone else's. Speak as yourself in the first person, in your own words, addressing others by NAME (never "seat N"); start straight into your point (do not prefix your line with a name label), and do not argue against your own lines (marked "(you)").`
    : `You are the first to speak, so there is nothing to go on yet beyond who has died. In 1-2 sentences (under 40 words), say plainly that there is no information to judge anyone on yet, and suggest how the town should start narrowing down the Mafia (for example, watching who votes for whom in today's vote). Do not accuse anyone of anything specific, and do not call anyone quiet or silent for not having spoken. Refer to the vote as "today's vote", never "tonight". Stay in character as ${ctx.persona.name}, ${ctx.persona.blurb}. Speak as yourself in the first person, addressing others by NAME (never "seat N"), and start straight into your point (do not prefix your line with a name label).`;
  return [
    `${header(ctx)} Your secret role is ${ctx.role}.`,
    RULES,
    ROLE_STANCE[ctx.role] ?? "",
    livingBlock(ctx),
    NO_INVENTION,
    ENGLISH_ONLY,
    CLAIM_GUIDANCE[ctx.role] ?? "",
    ``,
    phaseFraming(ctx),
    ...(events ? [events] : []),
    `Public discussion so far:`,
    transcriptBlock(ctx),
    ``,
    // The leaning is deliberately NOT injected: pushing a pre-chosen target makes a weak model
    // fabricate behaviour to justify it (esp. for a seat that has not spoken). Discussion stays
    // grounded in the transcript; the binding vote target is chosen later in its own reason call.
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
  return [
    `You are seat ${ctx.decisionStub.player} (role ${ctx.role}) in a Mafia game.`,
    `You have chosen to ${ctx.decisionStub.action} seat ${chosenTarget}.`,
    `Legal target seats: ${ctx.legalTargets.join(", ")}.`,
    ``,
    `Respond with ONLY this exact line of compact JSON, unchanged:`,
    skeleton,
    ``,
    `No prose, no code fences, no extra whitespace — only that JSON object.`,
  ].join("\n");
}
