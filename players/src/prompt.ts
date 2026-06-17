import type { Decision } from "@turingpits/engine";
import { encodeDecision } from "@turingpits/engine";
import type { TurnContext } from "./types.js";

/** The action each role performs at night, phrased for the model. */
const ACTION_VERB: Record<string, string> = {
  kill: "secretly kill",
  save: "protect from the night kill",
  investigate: "investigate the alignment of",
  vote: "vote to eliminate",
};

function transcriptBlock(ctx: TurnContext): string {
  if (ctx.transcript.length === 0) return "(no public discussion yet)";
  return ctx.transcript.map(([seat, text]) => `  seat ${seat}: ${text}`).join("\n");
}

/**
 * Free-form speech prompt: in-character reasoning streamed to the UI. Not load-bearing
 * for settlement, so the format is loose — only the spectacle depends on it.
 */
export function buildSpeechPrompt(ctx: TurnContext): string {
  const verb = ACTION_VERB[ctx.decisionStub.action] ?? ctx.decisionStub.action;
  return [
    `You are playing the social-deduction game Mafia as seat ${ctx.persona.seat}, "${ctx.persona.name}" (${ctx.persona.blurb}).`,
    `Your secret role is ${ctx.role}. Stay in character and play to win for your faction.`,
    `Living seats: ${ctx.alive.join(", ")}.`,
    ``,
    `Public discussion so far:`,
    transcriptBlock(ctx),
    ``,
    `It is the ${ctx.decisionStub.phase} phase of round ${ctx.decisionStub.round}. You are about to ${verb} another player.`,
    `In 1-2 sentences, share your in-character reasoning aloud. Do not reveal your role directly if it would hurt your faction.`,
  ].join("\n");
}

/**
 * Decision prompt (design spec §3 / `myTasks.md §A`): a constrained inference whose
 * *entire* output must be the canonical decision string. Every fixed field is pinned, so
 * the model's only freedom is the integer `target` — chosen from the legal set. The exact
 * output text is what the TEE signs and what the Solidity verifier reconstructs.
 */
export function buildDecisionPrompt(ctx: TurnContext): string {
  // Show the canonical skeleton with a placeholder target so the model copies it verbatim.
  const sample: Decision = { ...ctx.decisionStub, target: ctx.legalTargets[0] ?? 0 };
  const skeleton = encodeDecision(sample);
  return [
    `You are seat ${ctx.decisionStub.player} (role ${ctx.role}) in a Mafia game.`,
    `Choose your ${ctx.decisionStub.action} target. Legal target seats: ${ctx.legalTargets.join(", ")}.`,
    ``,
    `Respond with ONLY a single line of compact JSON in EXACTLY this form, changing only the "target" integer to your chosen legal seat:`,
    skeleton,
    ``,
    `No prose, no code fences, no extra whitespace — only that JSON object.`,
  ].join("\n");
}
