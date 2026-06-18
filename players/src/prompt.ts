import type { Decision } from "@turingpits/engine";
import { encodeDecision } from "@turingpits/engine";
import type { TurnContext } from "./types.js";

/** The action each role performs, phrased for the model. */
const ACTION_VERB: Record<string, string> = {
  kill: "secretly kill",
  save: "protect from the night kill",
  investigate: "investigate the alignment of",
  vote: "vote to eliminate",
};

/**
 * Role-specific stance. Only MAFIA is told it may deceive; the town-aligned roles
 * (DETECTIVE/DOCTOR/TOWN) are framed as honest Mafia-hunters, so a weak model stops
 * narrating "maintain our cover" out of a detective.
 */
const ROLE_STANCE: Record<string, string> = {
  MAFIA:
    "You are MAFIA. You secretly know your teammate(s). Blend in with the Town, deflect suspicion away from your team, and you may lie freely about your role and your reads.",
  DETECTIVE:
    "You are the DETECTIVE, on the Town's side. Each night you secretly learn one player's alignment. Use your findings to hunt the Mafia, but be careful: openly claiming to be the Detective paints a target on you.",
  DOCTOR:
    "You are the DOCTOR, on the Town's side. You protect players from the night kill and help the Town vote out the Mafia. Stay hidden so the Mafia cannot pick you off.",
  TOWN:
    "You are an ordinary TOWN member with no special powers. Reason honestly and openly from how players behave to find the Mafia and vote them out.",
};

function transcriptBlock(ctx: TurnContext): string {
  if (ctx.transcript.length === 0) return "(no public discussion yet)";
  return ctx.transcript.map(([seat, text]) => `  seat ${seat}: ${text}`).join("\n");
}

/** The "What you privately know" block, or "" when this seat knows nothing private. */
function privateKnowledgeBlock(ctx: TurnContext): string {
  const lines: string[] = [];
  if (ctx.role === "MAFIA" && ctx.teammates && ctx.teammates.length > 0) {
    lines.push(`Your fellow Mafia: ${ctx.teammates.map((s) => `seat ${s}`).join(", ")}. Never target them.`);
  }
  if (ctx.role === "DETECTIVE" && ctx.investigations && ctx.investigations.length > 0) {
    lines.push("Your investigation results so far:");
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
  return lines.length === 0 ? "" : ["What you privately know:", ...lines].join("\n");
}

function header(ctx: TurnContext): string {
  return (
    `You are playing the social-deduction game Mafia as seat ${ctx.persona.seat}, ` +
    `"${ctx.persona.name}" (${ctx.persona.blurb}).`
  );
}

/**
 * Reason prompt (call 1 of the three-call turn): the player privately picks who to target,
 * seeing everything it legitimately knows — role stance, private knowledge, the public
 * transcript, and its legal targets. Output is parsed by `parseReason`; not load-bearing for
 * settlement, so the format is a loose JSON object.
 */
export function buildReasonPrompt(ctx: TurnContext): string {
  const verb = ACTION_VERB[ctx.decisionStub.action] ?? ctx.decisionStub.action;
  const priv = privateKnowledgeBlock(ctx);
  return [
    header(ctx),
    ROLE_STANCE[ctx.role] ?? `Your secret role is ${ctx.role}.`,
    `Living seats: ${ctx.alive.join(", ")}.`,
    ``,
    ...(priv ? [priv, ``] : []),
    `Public discussion so far:`,
    transcriptBlock(ctx),
    ``,
    `It is the ${ctx.decisionStub.phase} phase of round ${ctx.decisionStub.round}. You must ${verb} one player.`,
    `Legal target seats: ${ctx.legalTargets.join(", ")}.`,
    ``,
    `Decide who to target and why. Respond with ONLY a single line of JSON in this form:`,
    `{"target": <one legal seat number>, "reason": "<one short sentence of in-character reasoning>"}`,
  ].join("\n");
}

/**
 * Speech prompt (call 2): in-character chatter streamed to the UI. It is handed the *already
 * chosen* target and the private reasoning so the speech justifies the real action, and it is
 * anchored to this seat's identity so the model stops parroting others or accusing itself.
 * Not load-bearing — only the spectacle depends on it.
 */
export function buildSpeechPrompt(ctx: TurnContext, chosenTarget: number, reason: string): string {
  const verb = ACTION_VERB[ctx.decisionStub.action] ?? ctx.decisionStub.action;
  return [
    `${header(ctx)} Your secret role is ${ctx.role}.`,
    ROLE_STANCE[ctx.role] ?? "",
    `Living seats: ${ctx.alive.join(", ")}.`,
    ``,
    `Public discussion so far:`,
    transcriptBlock(ctx),
    ``,
    `You have privately decided to ${verb} seat ${chosenTarget}. Your private reasoning: ${reason}`,
    `In 1-2 sentences, make your in-character case aloud to the table, consistent with that decision.`,
    `Speak in your own words — do not repeat what other players said. Never accuse yourself (you are seat ${ctx.persona.seat}). Do not reveal private information that would hurt your faction.`,
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
