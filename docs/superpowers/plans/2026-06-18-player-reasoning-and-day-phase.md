# Player Reasoning & Day-Phase Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI Mafia players reason coherently (use their own hard knowledge, save/kill with role-correct heuristics, stop hallucinating history, stop parroting) and turn the flat single-pass day into a discuss-then-vote phase with role claims and bluffing.

**Architecture:** All changes are confined to the `players/` workspace. Prompts gain per-role *actionable* decision rules, a prominent "FACTS YOU KNOW" block, information-state grounding, and role-claim guidance. The three non-signed inference calls (reason, speech, discussion) get a per-seat seed + temperature so identical scaffolding no longer collapses to identical text; the signed decision call is left byte-for-byte unchanged. `playMatch` splits each day into a discussion pass (free-form, unsigned, streamed) and a vote pass (the existing signed `vote` turn). Only signed turns reach `toSettlementMove`/settlement — the on-chain path is untouched.

**Tech Stack:** TypeScript (ESM), vitest, ethers v6, `@turingpits/engine` (workspace dep), `@0gfoundation/0g-compute-ts-sdk`.

## Global Constraints

- **Workspace:** all source and tests live under `players/`. Run tests from the repo root with `npm test -w @turingpits/players -- <relative/path/to/file>` (the workspace `test` script is `vitest run`). If a test fails to resolve `@turingpits/engine`, build it once: `npm run build -w @turingpits/engine`.
- **Signed decision call is sacrosanct.** The third inference (`buildDecisionPrompt` → `parseDecision`) — its request body, output format, parsing, and attestation handling — MUST stay identical to today. Sampling params (temperature/seed) are added ONLY to the non-signed reason/speech/discussion calls.
- **Only signed turns settle.** `AttestedMatch.turns` continues to hold ONLY night + vote turns. `toSettlementMove`, `runMatch` replay, and the contract path must never see a discussion entry.
- **Night secrecy preserved.** Night reasoning is never pushed into the public `transcript`.
- **Mocks stay labeled.** `MockLocalProvider` keeps `source: "MOCK-local"`; nothing is treated as a real attestation.
- **Existing `prompt.test.ts` invariants must keep passing.** In particular a TOWN *reason* prompt must NOT contain the substrings `"lie"` or `"cover"`. Beware: `believe`/`belief`/`lien` contain `"lie"`, and `discover`/`uncover` contain `"cover"`. Use words like `find`/`identify`/`judge`/`think` instead.

---

### Task 1: Per-role actionable prompts, FACTS block, info-state grounding, claim guidance

**Files:**
- Modify: `players/src/prompt.ts` (rewrite `ROLE_STANCE`, `transcriptBlock`, `privateKnowledgeBlock`, `buildReasonPrompt`, `buildSpeechPrompt`; add `DECISION_RULE`, `CLAIM_GUIDANCE`, `NO_INVENTION`)
- Test: `players/src/prompt.test.ts` (add assertions; keep all existing ones passing)

**Interfaces:**
- Consumes: `TurnContext` (existing — `persona`, `role`, `alive`, `transcript`, `decisionStub`, `legalTargets`, `teammates?`, `investigations?`, `ownHistory?`).
- Produces: `buildReasonPrompt(ctx)`, `buildSpeechPrompt(ctx, chosenTarget, reason)`, `buildDecisionPrompt(ctx, chosenTarget)` — same signatures as today, richer output.

- [ ] **Step 1: Write the failing tests**

Add to `players/src/prompt.test.ts` (keep the existing file content; append these `describe` blocks):

```ts
describe("buildReasonPrompt — role heuristics & grounding", () => {
  it("forbids the DETECTIVE from voting a confirmed-town seat", () => {
    const ctx: TurnContext = {
      ...base, role: "DETECTIVE",
      investigations: [{ round: 1, target: 0, faction: "TOWN" }],
      decisionStub: { nonce: "deadbeef", phase: "day", round: 2, player: 2, action: "vote" },
    };
    const p = buildReasonPrompt(ctx);
    expect(p).toContain("FACTS YOU KNOW");
    expect(p.toLowerCase()).toContain("never vote a seat you have confirmed town");
  });

  it("tells the DETECTIVE not to re-investigate a known seat", () => {
    const ctx: TurnContext = {
      ...base, role: "DETECTIVE",
      decisionStub: { nonce: "deadbeef", phase: "night", round: 2, player: 2, action: "investigate" },
      legalTargets: [0, 1, 3, 4],
    };
    expect(buildReasonPrompt(ctx).toLowerCase()).toContain("not yet learned");
  });

  it("tells the DOCTOR to protect likely kill targets, not suspects", () => {
    const ctx: TurnContext = {
      ...base, role: "DOCTOR",
      decisionStub: { nonce: "deadbeef", phase: "night", round: 1, player: 2, action: "save" },
      legalTargets: [0, 1, 2, 3, 4],
    };
    const p = buildReasonPrompt(ctx).toLowerCase();
    expect(p).toContain("most wants dead");
    expect(p).toContain("not who seems guilty");
  });

  it("tells MAFIA to remove threats and spare teammates on a kill", () => {
    const ctx: TurnContext = {
      ...base, role: "MAFIA", teammates: [4],
      decisionStub: { nonce: "deadbeef", phase: "night", round: 1, player: 2, action: "kill" },
      legalTargets: [0, 1, 3, 4],
    };
    const p = buildReasonPrompt(ctx);
    expect(p).toContain("seat 4");
    expect(p.toLowerCase()).toContain("never target a teammate");
  });

  it("grounds an empty transcript as 'no evidence' and forbids inventing history", () => {
    const ctx: TurnContext = { ...base, transcript: [],
      decisionStub: { nonce: "deadbeef", phase: "night", round: 1, player: 2, action: "vote" } };
    const p = buildReasonPrompt(ctx).toLowerCase();
    expect(p).toContain("no behavioral evidence");
    expect(p).toContain("never invent");
  });
});

describe("buildSpeechPrompt — claims", () => {
  it("lets a DETECTIVE choose to claim, naming the trade-off", () => {
    const ctx: TurnContext = { ...base, role: "DETECTIVE" };
    const p = buildSpeechPrompt(ctx, 3, "x").toLowerCase();
    expect(p).toContain("claim");
    expect(p).toContain("target");
  });

  it("lets MAFIA falsely claim a power role", () => {
    const ctx: TurnContext = { ...base, role: "MAFIA", teammates: [4] };
    expect(buildSpeechPrompt(ctx, 3, "x").toLowerCase()).toContain("falsely claim");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @turingpits/players -- src/prompt.test.ts`
Expected: FAIL — the new assertions miss strings ("FACTS YOU KNOW", "never vote a seat you have confirmed town", etc.); existing assertions still pass.

- [ ] **Step 3: Rewrite `players/src/prompt.ts`**

Replace the file's contents above `buildDecisionPrompt` (keep `buildDecisionPrompt` exactly as it is today) with:

```ts
import type { Decision } from "@turingpits/engine";
import { encodeDecision } from "@turingpits/engine";
import type { TurnContext } from "./types.js";

/** The action each role performs, phrased for the model. */
const ACTION_VERB: Record<string, string> = {
  kill: "secretly kill",
  save: "protect from tonight's kill",
  investigate: "investigate the alignment of",
  vote: "vote to eliminate",
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
    "You have no secret alignment information. Judge ONLY from what players actually said and how they voted. Treat every role claim as a claim, not proof. Do not invent behavior.",
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
    "If a player claims a power role, weigh it skeptically — the Mafia claim roles too. Two players claiming the same role means at least one is lying.",
};

/** Standing anti-hallucination rule shared by every prompt. */
const NO_INVENTION =
  "Only reference things that actually appear in the discussion below. Never invent prior rounds, votes, statements, or behavior.";

function header(ctx: TurnContext): string {
  return (
    `You are playing the social-deduction game Mafia as seat ${ctx.persona.seat}, ` +
    `"${ctx.persona.name}" (${ctx.persona.blurb}).`
  );
}

function transcriptBlock(ctx: TurnContext): string {
  if (ctx.transcript.length === 0) {
    return "(no discussion yet — this is the start of the game. You have NO behavioral evidence about anyone, so do not reference anyone's past behavior, votes, or statements: none exist.)";
  }
  return ctx.transcript.map(([seat, text]) => `  seat ${seat}: ${text}`).join("\n");
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
  const rule = decisionRule(ctx.role, ctx.decisionStub.action);
  return [
    header(ctx),
    ROLE_STANCE[ctx.role] ?? `Your secret role is ${ctx.role}.`,
    `Living seats: ${ctx.alive.join(", ")}.`,
    NO_INVENTION,
    ``,
    `It is the ${ctx.decisionStub.phase} phase of round ${ctx.decisionStub.round}.`,
    `Public discussion so far:`,
    transcriptBlock(ctx),
    ``,
    ...(facts ? [facts, ``] : []),
    `You must ${verb} one player.`,
    ...(rule ? [rule] : []),
    `Legal target seats: ${ctx.legalTargets.join(", ")}.`,
    ``,
    `Decide who to target and why. Respond with ONLY a single line of JSON in this form:`,
    `{"target": <one legal seat number>, "reason": "<one short sentence of in-character reasoning>"}`,
  ].join("\n");
}

/**
 * Speech prompt (call 2, DAY VOTE only): in-character justification of the already-chosen vote.
 * Anchored to this seat; given claim guidance so power roles can choose to reveal and Mafia can
 * bluff. Not load-bearing.
 */
export function buildSpeechPrompt(ctx: TurnContext, chosenTarget: number, reason: string): string {
  const verb = ACTION_VERB[ctx.decisionStub.action] ?? ctx.decisionStub.action;
  return [
    `${header(ctx)} Your secret role is ${ctx.role}.`,
    ROLE_STANCE[ctx.role] ?? "",
    `Living seats: ${ctx.alive.join(", ")}.`,
    NO_INVENTION,
    CLAIM_GUIDANCE[ctx.role] ?? "",
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
```

Keep the existing `buildDecisionPrompt` function below, unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @turingpits/players -- src/prompt.test.ts`
Expected: PASS — all existing assertions plus the new ones. If a TOWN reason test trips on `"lie"`/`"cover"`, search the new strings for `believe`/`belief`/`discover`/`uncover` and reword.

- [ ] **Step 5: Commit**

```bash
git add players/src/prompt.ts players/src/prompt.test.ts
git commit -m "feat(players): actionable per-role prompts, FACTS block, info-state grounding, role claims"
```

---

### Task 2: Per-seat inference diversity on the non-signed calls

**Files:**
- Modify: `players/src/types.ts` (add `SamplingOptions`; extend `InferenceProvider.complete`)
- Modify: `players/src/zerog.ts:53-59` (forward `temperature`/`seed` into the request body)
- Modify: `players/src/provider.ts:70` (accept and ignore the optional param)
- Modify: `players/src/player.ts` (compute a per-call seed; pass temperature+seed to reason & speech, NOT to decision)
- Test: `players/src/player.test.ts` (add a capturing-provider test)

**Interfaces:**
- Produces: `SamplingOptions = { temperature?: number; seed?: number }`; `InferenceProvider.complete(prompt: string, opts?: SamplingOptions)`.
- Consumes (Task 3/4 rely on this): `Player` passes `{ temperature: 0.8, seed }` on non-signed calls; the signed decision call passes no opts.

- [ ] **Step 1: Write the failing test**

Append to `players/src/player.test.ts` (create the file with this content if it does not yet exist; otherwise append the `describe` block and the imports it needs):

```ts
import { describe, it, expect } from "vitest";
import { Player } from "./player.js";
import type { InferenceProvider, SamplingOptions, TurnContext } from "./types.js";
import { MockLocalProvider } from "./provider.js";

function capturing(): { provider: InferenceProvider; calls: { prompt: string; opts?: SamplingOptions }[] } {
  const base = new MockLocalProvider("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const calls: { prompt: string; opts?: SamplingOptions }[] = [];
  return {
    calls,
    provider: { async complete(prompt, opts) { calls.push({ prompt, opts }); return base.complete(prompt, opts); } },
  };
}

function voteCtx(seat: number): TurnContext {
  return {
    persona: { seat, name: `P${seat}`, blurb: "a player" },
    role: "TOWN",
    alive: [0, 1, 2],
    transcript: [],
    decisionStub: { nonce: "n", phase: "day", round: 1, player: seat, action: "vote" },
    legalTargets: [0, 1, 2].filter((i) => i !== seat),
  };
}

describe("Player inference diversity", () => {
  it("passes temperature+seed to non-signed calls but none to the signed decision call", async () => {
    const { provider, calls } = capturing();
    await new Player(provider).takeTurn(voteCtx(0));
    // 3 calls: reason, speech, decision (day vote).
    expect(calls.length).toBe(3);
    expect(calls[0]!.opts?.temperature).toBeGreaterThan(0); // reason
    expect(calls[1]!.opts?.temperature).toBeGreaterThan(0); // speech
    expect(calls[1]!.opts?.seed).toBeTypeOf("number");
    expect(calls[2]!.opts).toBeUndefined();                  // signed decision: unchanged request
  });

  it("derives a different seed per seat for the same turn", async () => {
    const a = capturing();
    const b = capturing();
    await new Player(a.provider).takeTurn(voteCtx(0));
    await new Player(b.provider).takeTurn(voteCtx(1));
    expect(a.calls[1]!.opts?.seed).not.toBe(b.calls[1]!.opts?.seed);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @turingpits/players -- src/player.test.ts`
Expected: FAIL — `complete` does not yet accept opts (TS compile error or `opts` undefined on calls 0/1).

- [ ] **Step 3a: Extend the provider interface (`players/src/types.ts`)**

Replace the `InferenceProvider` interface (lines 115-118) with:

```ts
/** Optional sampling controls for the NON-signed calls only (reason/speech/discussion). */
export interface SamplingOptions {
  readonly temperature?: number;
  readonly seed?: number;
}

/**
 * One TEE-attested inference. Implemented by the real 0G Compute provider and by the
 * labeled local mock. `complete` returns the model text plus the attestation over it.
 * `opts` carries sampling controls for non-signed calls; the signed decision call omits it,
 * keeping its request identical for settlement.
 */
export interface InferenceProvider {
  complete(prompt: string, opts?: SamplingOptions): Promise<{ text: string; attestation: Attestation }>;
}
```

- [ ] **Step 3b: Forward params in the real provider (`players/src/zerog.ts`)**

Change the `complete` signature and request body (lines 53-59) to:

```ts
  async complete(
    prompt: string,
    opts?: import("./types.js").SamplingOptions,
  ): Promise<{ text: string; attestation: Attestation }> {
    const headers = await this.broker.inference.getRequestHeaders(this.providerAddress, prompt);
    const reqBody: Record<string, unknown> = { model: this.model, messages: [{ role: "user", content: prompt }] };
    if (opts?.temperature !== undefined) reqBody.temperature = opts.temperature;
    if (opts?.seed !== undefined) reqBody.seed = opts.seed;
    const res = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(reqBody),
    });
```

> Note: the TEE envelope signs the *response*, and `reqHashHex` (envelope part[0]) is the provider's own request hash, so adding `temperature`/`seed` to the body does not affect settlement. `seed` is forwarded best-effort — if the qwen endpoint ignores it, `temperature` alone still breaks the mode-collapse. Omitting `opts` reproduces today's exact request.

- [ ] **Step 3c: Accept-and-ignore in the mock (`players/src/provider.ts`)**

Change `complete` (line 70) to:

```ts
  async complete(
    prompt: string,
    _opts?: import("./types.js").SamplingOptions,
  ): Promise<{ text: string; attestation: Attestation }> {
```

(The mock stays deterministic per prompt; sampling params are intentionally ignored.)

- [ ] **Step 3d: Drive the params from `players/src/player.ts`**

Add the import and helpers at the top (after the existing imports):

```ts
import { createHash } from "node:crypto";
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
```

(Remove the now-duplicated `import type { InferenceProvider, PlayerTurn, TurnContext }` line if present.)

In `takeTurn`, pass sampling to the reason and speech calls, and nothing to the decision call:

```ts
      const reasonResult = await this.provider.complete(buildReasonPrompt(ctx), sampling(ctx, "reason"));
```

```ts
      const speechResult = await this.provider.complete(
        buildSpeechPrompt(ctx, chosen.target, chosen.reason),
        sampling(ctx, "speech"),
      );
```

Leave the decision call exactly as today (no second argument):

```ts
      const decisionResult = await this.provider.complete(buildDecisionPrompt(ctx, chosen.target));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @turingpits/players -- src/player.test.ts`
Expected: PASS. Also run the full players suite to confirm no regression: `npm test -w @turingpits/players`
Expected: PASS (mock ignores opts, so `match.test.ts` determinism holds).

- [ ] **Step 5: Commit**

```bash
git add players/src/types.ts players/src/zerog.ts players/src/provider.ts players/src/player.ts players/src/player.test.ts
git commit -m "feat(players): per-seat temperature+seed on non-signed inference calls"
```

---

### Task 3: Discussion stage — `stage` field, `buildDiscussionPrompt`, `Player.discuss`

**Files:**
- Modify: `players/src/types.ts` (add `stage?` to `TurnContext`)
- Modify: `players/src/prompt.ts` (add `buildDiscussionPrompt`)
- Modify: `players/src/player.ts` (add `Player.discuss`)
- Test: `players/src/prompt.test.ts` (discussion prompt), `players/src/player.test.ts` (discuss returns speech-only)

**Interfaces:**
- Consumes: `buildReasonPrompt`, `parseReason`, `sampling` (Task 2), `SamplingOptions`.
- Produces:
  - `TurnContext.stage?: "night" | "discussion" | "vote"`.
  - `buildDiscussionPrompt(ctx: TurnContext, leaning: number, reason: string): string`.
  - `Player.discuss(ctx: TurnContext): Promise<{ speech: string }>` — runs reason→discussion-speak, NO decision, NO attestation.

- [ ] **Step 1: Write the failing tests**

Append to `players/src/prompt.test.ts`:

```ts
import { buildDiscussionPrompt } from "./prompt.js";

describe("buildDiscussionPrompt", () => {
  it("asks for a debate contribution reacting to a named player, no decision JSON", () => {
    const ctx: TurnContext = { ...base, role: "TOWN", stage: "discussion" };
    const p = buildDiscussionPrompt(ctx, 3, "seat 3 keeps dodging");
    expect(p.toLowerCase()).toContain("contribute to the debate");
    expect(p).toContain("seat 3");        // the leaning
    expect(p).not.toContain('"target"');  // free-form, not a decision
  });

  it("carries claim guidance so a DETECTIVE can choose to reveal", () => {
    const ctx: TurnContext = { ...base, role: "DETECTIVE", stage: "discussion" };
    expect(buildDiscussionPrompt(ctx, 1, "x").toLowerCase()).toContain("claim");
  });
});
```

Append to `players/src/player.test.ts`:

```ts
describe("Player.discuss", () => {
  it("returns a speech with no structured decision and no attestation", async () => {
    const { provider, calls } = capturing();
    const ctx: TurnContext = { ...voteCtx(0), stage: "discussion" };
    const result = await new Player(provider).discuss(ctx);
    expect(typeof result.speech).toBe("string");
    expect(result.speech.length).toBeGreaterThan(0);
    expect((result as Record<string, unknown>).structuredDecision).toBeUndefined();
    // 2 calls: reason (leaning) then discussion speech — never a decision.
    expect(calls.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @turingpits/players -- src/prompt.test.ts src/player.test.ts`
Expected: FAIL — `buildDiscussionPrompt` and `Player.discuss` do not exist; `stage` is not on `TurnContext`.

- [ ] **Step 3a: Add `stage` to `TurnContext` (`players/src/types.ts`)**

Inside the `TurnContext` interface (after the `legalTargets` field, before `teammates?`), add:

```ts
  /** Which turn stage this context is for. Defaults follow `decisionStub.phase` when omitted. */
  readonly stage?: "night" | "discussion" | "vote";
```

- [ ] **Step 3b: Add `buildDiscussionPrompt` (`players/src/prompt.ts`)**

Add after `buildSpeechPrompt` (it reuses the module-level `header`, `transcriptBlock`, `ROLE_STANCE`, `CLAIM_GUIDANCE`, `NO_INVENTION`):

```ts
/**
 * Discussion prompt (DAY discussion pass): free-form debate before the vote. The seat is given
 * its private leaning (from a reason call) and pushes the debate forward — reacting to a named
 * player and adding one new point, optionally claiming/bluffing a role. Never produces a
 * decision; not load-bearing.
 */
export function buildDiscussionPrompt(ctx: TurnContext, leaning: number, reason: string): string {
  return [
    `${header(ctx)} Your secret role is ${ctx.role}.`,
    ROLE_STANCE[ctx.role] ?? "",
    `Living seats: ${ctx.alive.join(", ")}.`,
    NO_INVENTION,
    CLAIM_GUIDANCE[ctx.role] ?? "",
    ``,
    `Public discussion so far:`,
    transcriptBlock(ctx),
    ``,
    `Your current private leaning: seat ${leaning}. Why: ${reason}`,
    `It is open discussion before the vote. In 1-2 sentences, contribute to the debate: react to a SPECIFIC named player and add ONE new point. Do not restate what has already been said, and never accuse yourself (you are seat ${ctx.persona.seat}).`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
```

- [ ] **Step 3c: Add `Player.discuss` (`players/src/player.ts`)**

Import `buildDiscussionPrompt` in the prompt import line:

```ts
import { buildDecisionPrompt, buildDiscussionPrompt, buildReasonPrompt, buildSpeechPrompt } from "./prompt.js";
```

Add this method to the `Player` class (after `takeTurn`):

```ts
  /**
   * DAY discussion-pass turn: reason a private leaning, then speak free-form into the debate.
   * Produces NO structured decision and NO attestation — discussion speech is never signed and
   * never settles. Resampling/fallback for the leaning mirrors `takeTurn`.
   */
  async discuss(ctx: TurnContext): Promise<{ speech: string }> {
    let chosen = { target: ctx.legalTargets[0] ?? 0, reason: "" };
    for (let attempt = 0; attempt <= this.decisionRetries; attempt++) {
      const reasonResult = await this.provider.complete(buildReasonPrompt(ctx), sampling(ctx, "reason"));
      try {
        chosen = parseReason(reasonResult.text, ctx.legalTargets);
        break;
      } catch {
        // keep resampling; deterministic default stands
      }
    }
    const speechResult = await this.provider.complete(
      buildDiscussionPrompt(ctx, chosen.target, chosen.reason),
      sampling(ctx, "discuss"),
    );
    return { speech: speechResult.text };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @turingpits/players -- src/prompt.test.ts src/player.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add players/src/types.ts players/src/prompt.ts players/src/player.ts players/src/prompt.test.ts players/src/player.test.ts
git commit -m "feat(players): add discussion stage, buildDiscussionPrompt, and Player.discuss"
```

---

### Task 4: Two-pass day (`discussion → vote`) in `playMatch`

**Files:**
- Modify: `players/src/match.ts` (`MatchConfig`, `playMatch`; add `DiscussionEntry`, `onDiscussion`; set `ctx.stage`)
- Test: `players/src/match.test.ts` (new discussion-pass tests; update the night-secrecy test's custom `respond`)

**Interfaces:**
- Consumes: `Player.takeTurn` (night + vote), `Player.discuss` (discussion), engine `applyDecision`/`winner`.
- Produces:
  - `interface DiscussionEntry { readonly seat: number; readonly round: number; readonly speech: string; }`
  - `MatchConfig.onDiscussion?: (entry: DiscussionEntry, state: GameState) => void | Promise<void>`
  - `AttestedMatch.turns` unchanged (signed night + vote turns only).

- [ ] **Step 1: Write the failing tests**

In `players/src/match.test.ts`, first **update** the existing `respond` in the "never broadcasts night reasoning" test so a discussion prompt yields public prose (otherwise it throws on the missing "Legal target seats"). Replace its body with:

```ts
    const respond = (prompt: string): string => {
      if (prompt.startsWith("You are seat")) {
        return prompt.split("\n").find((l) => l.trimStart().startsWith('{"nonce"'))!.trim();
      }
      if (prompt.includes("contribute to the debate")) return `DISCUSSION_${n++}_`;
      if (prompt.includes("make your in-character case aloud")) return `PUBLICSPEECH_${n++}_`;
      const legal = prompt.match(/Legal target seats: ([\d, ]+)/)![1].split(",").map((s) => Number(s.trim()));
      return `{"target":${legal[0]},"reason":"PRIVATEREASON_${n++}_"}`;
    };
```

Then append a new test:

```ts
  it("runs a day as a discussion pass then a vote pass", async () => {
    const discussion: { seat: number; round: number; speech: string }[] = [];
    const votes: { seat: number; round: number }[] = [];
    await playMatch({
      seed: SEED, n: 5, nonce: NONCE, personas, players: buildPlayers(),
      onDiscussion: (e) => { discussion.push(e); },
      onTurn: (t) => { if (t.structuredDecision.phase === "day") votes.push({ seat: t.seat, round: t.structuredDecision.round }); },
    });
    // Round 1 day: 5 living seats discuss, then 5 vote.
    const round1Discussion = discussion.filter((d) => d.round === 1);
    const round1Votes = votes.filter((v) => v.round === 1);
    expect(round1Discussion.length).toBe(5);
    expect(round1Votes.length).toBe(5);
    // Every discussion entry carries a non-empty speech and no decision leaks into `turns`.
    expect(round1Discussion.every((d) => d.speech.length > 0)).toBe(true);
  });

  it("keeps discussion speech out of the settlement turns but inside the transcript", async () => {
    const prompts: string[] = [];
    const base = new MockLocalProvider(PROVIDER_KEY);
    const capturingProvider: InferenceProvider = {
      async complete(p, o) { prompts.push(p); return base.complete(p, o); },
    };
    const result = await playMatch({
      seed: SEED, n: 5, nonce: NONCE, personas,
      players: personas.map(() => new Player(capturingProvider)),
    });
    // Settlement turns are only night + day-vote decisions.
    for (const t of result.turns) {
      expect(["night", "day"]).toContain(t.structuredDecision.phase);
      expect(t.structuredDecision.action === "vote" || t.structuredDecision.phase === "night").toBe(true);
      toSettlementMove(t); // must not throw — every recorded turn is a real signed decision
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @turingpits/players -- src/match.test.ts`
Expected: FAIL — `onDiscussion` is not invoked (no discussion pass yet); `round1Discussion.length` is 0.

- [ ] **Step 3a: Add the discussion types to `players/src/match.ts`**

After the `RecordedTurn` interface (line 28), add:

```ts
/** One unsigned public discussion contribution during a day's discussion pass. */
export interface DiscussionEntry {
  readonly seat: number;
  readonly round: number;
  readonly speech: string;
}
```

In `MatchConfig`, add (next to `onTurn`):

```ts
  /**
   * Optional hook fired for each unsigned discussion contribution in the day's discussion pass
   * (before any vote). Discussion is public speech but never signed and never settles. Awaited.
   */
  readonly onDiscussion?: (entry: DiscussionEntry, state: GameState) => void | Promise<void>;
```

- [ ] **Step 3b: Rewrite the `playMatch` main loop (`players/src/match.ts:178-205`)**

Replace the `while (winnerOf(state) === null) { ... }` body. `phaseActors` is still used for the night branch; the day branch is now two passes. Replace from `const { onTurn } = config;` (line 173) through the end of the `while` loop with:

```ts
  const { onTurn, onDiscussion } = config;
  let state = initState(seed, n, nonce);
  const turns: RecordedTurn[] = [];
  const transcript: [number, string][] = [];

  const livingSeats = (s: GameState): number[] => s.players.filter((p) => p.alive).map((p) => p.id);

  // Build the context a seat needs this turn (private knowledge derived from full state + turns).
  const ctxFor = (
    seat: number,
    action: Action,
    legalTargets: number[],
    stage: "night" | "discussion" | "vote",
  ): TurnContext => ({
    persona: personas[seat]!,
    role: state.players[seat]!.role,
    alive: livingSeats(state),
    transcript: transcript.map(([s, t]) => [s, t] as const),
    decisionStub: { nonce, phase: state.phase, round: state.round, player: seat, action },
    legalTargets,
    stage,
    ...privateKnowledge(state, turns, seat, state.players[seat]!.role),
  });

  // Apply one signed turn (night action or day vote): record it, advance state, stream it.
  const applySignedTurn = async (ctx: TurnContext): Promise<boolean> => {
    const seat = ctx.decisionStub.player;
    const turn = await players[seat]!.takeTurn(ctx);
    state = applyDecision(state, turn.structuredDecision);
    const recorded: RecordedTurn = { seat, ...turn };
    turns.push(recorded);
    // Day vote justifications are public; night reasoning is never broadcast.
    if (turn.structuredDecision.phase === "day") transcript.push([seat, turn.speech]);
    if (onTurn) await onTurn(recorded, state);
    return winnerOf(state) !== null;
  };

  while (winnerOf(state) === null) {
    if (state.round > maxRounds) throw new Error(`match exceeded ${maxRounds} rounds without a winner`);

    if (state.phase === "night") {
      for (const { seat, action, legalTargets } of phaseActors(state)) {
        if (await applySignedTurn(ctxFor(seat, action, legalTargets, "night"))) break;
      }
    } else {
      // DAY — discussion pass (unsigned, streamed), then vote pass (signed).
      const living = livingSeats(state);
      for (const seat of living) {
        const targets = living.filter((id) => id !== seat);
        const { speech } = await players[seat]!.discuss(ctxFor(seat, "vote", targets, "discussion"));
        transcript.push([seat, speech]);
        if (onDiscussion) await onDiscussion({ seat, round: state.round, speech }, state);
      }
      for (const seat of living) {
        const targets = living.filter((id) => id !== seat);
        if (await applySignedTurn(ctxFor(seat, "vote", targets, "vote"))) break;
      }
    }
  }

  return { winner: winnerOf(state), turns, finalState: state };
}
```

> `Action` and `TurnContext` are already imported at the top of `match.ts` (`import type { Action, ... }` and `import type { ..., TurnContext } from "./types.js"`). The old `phaseActors` helper is still used for the night branch — leave it in place.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @turingpits/players -- src/match.test.ts`
Expected: PASS — including the existing determinism, attestation, replay, onTurn-ordering, and night-secrecy tests (vote justifications still reach the transcript, so the "day speech IS public" assertion holds).

Then the whole suite: `npm test -w @turingpits/players`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add players/src/match.ts players/src/match.test.ts
git commit -m "feat(players): two-pass day (discussion then vote) with onDiscussion hook"
```

---

### Task 5: Stream discussion into the live runner log

**Files:**
- Modify: `players/scripts/live-match.mjs` (capture + log discussion entries; label day sub-phases; persist `discussion` in the JSON)

**Interfaces:**
- Consumes: `playMatch`'s new `onDiscussion(entry, state)` hook and `DiscussionEntry` shape (`{ seat, round, speech }`).

- [ ] **Step 1: Add a discussion logger and capture array**

In `players/scripts/live-match.mjs`, just before `const onTurn = (turn, state) => {` (line 117), add:

```js
const discussionLog = [];
const onDiscussion = (entry, state) => {
  const header = `DAY — round ${entry.round} · discussion`;
  if (header !== curPhase) { curPhase = header; log(`\n### ${header}\n`); }
  const alive = state.players.filter((p) => p.alive).map((p) => p.id);
  log(`**${nameOf(entry.seat)}** (seat ${entry.seat}, ${roleNames[entry.seat]})`);
  log(`> ${entry.speech.trim()}`);
  log(`- _open discussion (unsigned public speech)_  ·  alive: [${alive.join(", ")}]\n`);
  discussionLog.push(entry);
};
```

- [ ] **Step 2: Distinguish the day vote sub-phase header in `onTurn`**

In the existing `onTurn`, change the header line (line 119) from:

```js
  const header = `${d.phase.toUpperCase()} — round ${d.round}`;
```

to:

```js
  const header = d.phase === "day" ? `DAY — round ${d.round} · vote` : `${d.phase.toUpperCase()} — round ${d.round}`;
```

- [ ] **Step 3: Pass `onDiscussion` into `playMatch`**

Change the `playMatch` call (line 132) to include the new hook:

```js
  match = await players.playMatch({ seed: SEED, n: N, nonce: NONCE, personas: PERSONAS, players: playerSeats, onTurn, onDiscussion });
```

- [ ] **Step 4: Persist discussion in both JSON writes**

In the first `writeFileSync(JSON_OUT, ...)` (line 141-145) and the final one (line 206-211), add `discussion: discussionLog,` to the serialized object (alongside `turns: match.turns`). For example the first becomes:

```js
writeFileSync(JSON_OUT, JSON.stringify({
  seed: SEED, nonce: NONCE, network: "0g-galileo-16602",
  teeSigner: provider.teeSignerAddress, commit, salt, roles: roleNames,
  winner: match.winner, turns: match.turns, discussion: discussionLog,
}, null, 2));
```

- [ ] **Step 5: Verify the script parses (no live 0G spend)**

Run: `node --check players/scripts/live-match.mjs`
Expected: no output, exit 0 (syntax valid). A full live run (`node --env-file=.env players/scripts/live-match.mjs`) spends testnet 0G and is the user's call to run later — do not run it as part of this plan.

- [ ] **Step 6: Commit**

```bash
git add players/scripts/live-match.mjs
git commit -m "feat(players): log discussion pass in the live match runner"
```

---

## Self-Review

**Spec coverage:**
- §1 actionable per-role prompts + FACTS block → Task 1. ✓
- §2 role claims & bluffing → Task 1 (`CLAIM_GUIDANCE` in speech) + Task 3 (discussion). ✓
- §3 information-state grounding → Task 1 (`NO_INVENTION`, empty-transcript text). ✓
- §4 inference diversity (temperature + per-seat seed on non-signed calls) → Task 2. ✓
- §5 discuss-pass → vote-pass day, `stage` discriminator, discussion turns speech-only, `toSettlementMove` sees only signed turns, night secrecy → Tasks 3 + 4. ✓
- Integrity invariants (signed call unchanged, turns signed-only) → enforced in Task 2 (no opts on decision call) and Task 4 (turns array). ✓
- Streaming/logging gains discussion turns → Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**Type consistency:** `SamplingOptions` (Task 2) is the same type referenced in Tasks 3-4. `TurnContext.stage` (Task 3) values `"night" | "discussion" | "vote"` match the `ctxFor(...)` stage arg in Task 4. `DiscussionEntry { seat, round, speech }` (Task 4) matches the `onDiscussion` consumer in Task 5. `Player.discuss(ctx): Promise<{ speech }>` (Task 3) matches its call site in Task 4. ✓
