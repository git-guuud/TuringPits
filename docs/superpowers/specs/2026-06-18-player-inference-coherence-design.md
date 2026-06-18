# Player Inference Coherence — Design

_Date: 2026-06-18 · Scope: `players/` only_

## Problem

A live match (`live-match-2026-06-18T13-02-46-219Z.md`) exposed three inference defects:

1. **Speech and action disagree.** Ada's DAY-1 speech argues to eliminate seat 1, but her
   vote lands on seat 3. Every seat shows the same split.
2. **Town roles talk like Mafia.** The DETECTIVE, DOCTOR, and TOWN all narrate "maintain our
   cover / manipulate the situation" — deception language only Mafia should use.
3. **Parroting / self-accusation.** Boris (seat 1, MAFIA) copies Ada's line verbatim and
   accuses "seat 1" — himself.

### Root cause

`Player.takeTurn` makes **two independent inferences** with no shared state
(`player.ts:33`, `player.ts:41`):

- `buildSpeechPrompt` gets the full context (transcript, role, alive) but makes **no choice**.
- `buildDecisionPrompt` makes the choice but is fed **only role + legal targets** — no
  transcript, no strategy, no link to what the speech argued.

The talker has the information; the decider is blind; they never meet. Hence the split
target (#1). The single generic "play to win for your faction / don't reveal your role"
framing drives every role toward Mafia-speak (#2). The verbatim transcript block with no
identity anchor invites parroting (#3).

## Design

### 1. Turn flow: `reason → speak → decide` (`player.ts`)

Three inferences per turn, in order:

1. **Reason (private, not load-bearing).** `buildReasonPrompt(ctx)` receives the full
   context — role stance, public transcript, living seats, this turn's action + legal
   targets, and the private-knowledge block — and returns
   `{"target": <legal seat>, "reason": "<one line>"}`. `parseReason(text, legalTargets)`
   extracts a legal target (lenient: JSON `target`, else first legal integer in the text).
   If none is found, resample up to the retry cap, then **fall back to a deterministic legal
   pick** (`legalTargets[0]`) so a weak model can never stall a live match.
2. **Speak (public, streamed).** `buildSpeechPrompt(ctx, chosenTarget, reason)` is handed the
   *actual* chosen target and the private reason, and writes 1–2 in-character sentences.
   Role-appropriate stance; anchored to "you are seat X / {name}"; explicitly instructed
   **not to repeat other players verbatim, not to accuse yourself, and not to leak private
   info that hurts your faction.** Non-load-bearing — its attestation is discarded (as today).
3. **Decide (constrained, signed — integrity unchanged).** `buildDecisionPrompt(ctx,
   chosenTarget)` pins the canonical skeleton to `chosenTarget` and asks for that exact line.
   `parseDecision` validates byte-exact canonical/legal, **and** we additionally assert
   `parsed.target === chosenTarget`; any drift/non-canonical output is resampled (same retry
   path as today). The output still *is* the TEE-signed bytes the contract reconstructs — the
   settlement path is untouched, and the attestation returned is this call's.

This pins call 3 to call 1's target and validates it, eliminating reason↔decision drift.

### 2. Role-appropriate framing (`prompt.ts`)

A per-role stance block, used by both reason and speech prompts:

- **MAFIA** — secretly know your teammate(s); blend in, deflect, you may lie.
- **DETECTIVE** — town-aligned; you secretly learn alignments; revealing paints a target on you.
- **DOCTOR** — town-aligned; protect the town; stay hidden.
- **TOWN** — town-aligned; no special info; reason openly from public behavior to find Mafia.

Only MAFIA receives deception/"cover" language. Town roles get "honestly hunt the Mafia."

### 3. Private knowledge in `TurnContext` (`types.ts` + `match.ts`)

New optional fields, populated by `match.ts` from the full `state` + recorded `turns`:

- `teammates?: readonly number[]` — MAFIA: the other Mafia seats.
- `investigations?: readonly {round, target, faction}[]` — DETECTIVE: its own results
  (filtered from `state.investigations` where `detective === seat`).
- `ownHistory?: readonly {round, phase, action, target}[]` — this seat's prior decisions
  (from recorded `turns`), covering doctor saves / past votes.

Rendered as a "What you privately know" block in the reason prompt; omitted when empty.

### 4. Mock provider (`provider.ts`)

`mockRespond` gains a reason branch: a prompt that lists "Legal target seats:" but has **no**
`{"nonce"...}` skeleton line is a reason prompt → emit `{"target":N,"reason":"..."}` with `N`
a deterministic legal pick. Detection order: decision (skeleton line) → reason (legal-targets,
no skeleton) → speech (prose). Keeps offline/CI matches coherent and deterministic.

## Testing

- **Prompt builders:** MAFIA gets teammates + lie license; TOWN/DETECTIVE/DOCTOR do **not**
  get "cover"; DETECTIVE gets its investigation results; the speech prompt forbids
  self-accusation and parroting and includes the chosen target + reason.
- **`parseReason`:** parses JSON target, extracts a bare legal integer, rejects illegal.
- **`player.ts`:** the structured decision target always equals the reasoned target
  (drift → resample); an illegal reasoned target falls back to a legal pick; the existing
  attestation/settlement-binding guarantees still hold.
- **`match.ts`:** a MAFIA seat's ctx carries `teammates`; a DETECTIVE's carries its prior
  investigation with faction; every seat carries its own history.
- **Coherence invariant (mock end-to-end):** the seat targeted by the decision is the seat
  the reasoning chose — speech and action no longer diverge.

## Out of scope

`settle()`'s "bad TEE signature" revert in the recorded match is an envelope bug, not an
inference defect. Tracked separately; untouched here.
