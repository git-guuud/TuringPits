# Player Reasoning & Day-Phase Rework — Design

_Date: 2026-06-18 · Scope: `players/` only (prompt.ts, player.ts, match.ts, types.ts,
zerog.ts, provider.ts mock, scripts/live-match.mjs). No engine rule changes; no model swap._

## Problem

A live match (`live-match-2026-06-18T18-48-23-778Z.md`) exposed a second layer of inference
defects, distinct from the speech↔action divergence fixed in
`2026-06-18-player-inference-coherence-design.md`. The data flow is **mostly correct** — the
defects are that the prompts don't make a weak model *use* the data it's given, plus an output
diversity collapse:

1. **Power roles ignore their own hard knowledge.** The DETECTIVE investigates seat 0 on
   night 1 (result recorded in `state.investigations`, correctly surfaced into the prompt by
   `match.ts:114-118` / `prompt.ts:40-45` as "round 1: seat 0 is TOWN"), then **votes to
   eliminate seat 0 — a seat it just confirmed TOWN.** The fact is *listed* in the prompt but
   never framed as actionable, so the model treats it as flavor.
2. **The DOCTOR protects whoever it finds *suspicious*.** It reasons "I suspect seat 0 is
   Mafia" and then *saves* seat 0 (log lines 30-32). The `save` action inherits the universal
   "find the guilty one" pattern because no save-specific heuristic exists. A save should
   reason about who the **Mafia will kill**, not who is guilty.
3. **Night-1 hallucination.** On round 1, with no discussion yet, players fabricate history:
   "Seat 0 seems overly confident and aggressive," "over the past few rounds." The prompt shows
   "(no public discussion yet)" but never tells the model what is and isn't knowable, nor
   forbids inventing past behavior.
4. **Verbatim parroting.** Every player emits a near-identical sentence ("I've been closely
   observing Seat X's behavior over the past few rounds…"). Root cause: `zerog.ts:58` sends
   `{ model, messages }` with **no temperature, no seed, no top-k** — the IDEA's "deterministic
   decoding" is not actually implemented, and speech is **not** TEE-signed (only the decision
   call's attestation is retained, `player.ts:69`). The repetition is mode collapse from
   identical prompt scaffolding plus each speaker seeing the previous identical speech in the
   transcript. Because the reason/speech calls are non-signed, we have free rein to vary them.
5. **No real social deduction.** The day is a single pass (`match.ts:140-157`,
   `playMatch:182-204`): one speech per player in fixed seat order, with the vote baked into the
   same turn. There is no discussion *before* voting, no reacting to each other, no role claims
   or accusations — so the spectacle is flat and the town can never coordinate on hidden info.

## Design

Four coordinated changes. None touch the signed decision path or the engine rules.

### 1. Per-role *actionable* prompts (`prompt.ts`)

Replace the passive role *stance* + passive private-knowledge footnote with a directive,
action-specific **decision rule** placed immediately before the decision instruction, and
promote private knowledge to a prominent **"FACTS YOU KNOW (certain — act on them)"** block.

Per role × action:

- **DETECTIVE**
  - `investigate`: "Pick a seat you have **not** yet investigated. Never re-investigate a seat
    whose alignment you already know."
  - `vote`: "You have hard knowledge from your investigations. **Never vote a seat you
    confirmed TOWN.** If you have confirmed a Mafia, push the table onto them. Otherwise vote
    the most suspicious seat you have *not* yet cleared."
- **DOCTOR**
  - `save`: "You protect against tonight's kill. Reason about **who the Mafia will most want
    dead** — vocal town leaders, anyone who has claimed a power role this game — **not** who
    seems guilty. Protecting yourself is allowed but predictable."
  - `vote`: standard town reasoning (below), plus its own-history awareness.
- **MAFIA**
  - `kill`: "Eliminate the biggest threat to your team — confident town voices, anyone who has
    claimed Detective/Doctor. **Never target your known teammate(s).**"
  - `vote`: "Deflect suspicion from your team. Vote with the town's momentum onto a town
    target, or onto whoever threatens your team — never your teammate."
- **TOWN** (and DOCTOR/DETECTIVE day reasoning baseline)
  - `vote`: "You have no secret alignment info. Reason **only** from what players actually said
    and how they voted. Treat role claims as claims, not proof. Do not invent behavior."

The **FACTS YOU KNOW** block (rendered only when non-empty) carries: MAFIA teammates,
DETECTIVE investigation results, and this seat's own prior moves. It is the same data
`privateKnowledge` already computes (`match.ts:99-126`) — only its prominence and framing
change.

### 2. Role claims & bluffing (prompt guidance — emergent, no new mechanic)

Discussion is free-form text, so claims/counter-claims appear naturally in the transcript. The
prompts give every role the option-space and the trade-offs:

- **DETECTIVE / DOCTOR** *may* claim their role and share findings during the discussion pass,
  or stay hidden. Guidance states the trade-off: claiming helps the town coordinate but marks
  you as the Mafia's next kill (and a claimed Detective is exactly who the Doctor should
  consider protecting — see §1).
- **MAFIA** *may* fake-claim Detective/Doctor to misdirect the town and accuse an innocent.
- **All roles**: "Role claims are not proof. If two players both claim the same power role, at
  least one is lying — weigh who is more credible."

This is purely additive prompt text; it reinforces the Doctor-save and Mafia-kill heuristics
in §1 (both already reference "claimed a power role"). No structural change.

### 3. Information-state grounding (`prompt.ts`)

- Every prompt states the current round and phase explicitly.
- A standing rule in all prompts: "Only reference things that actually appear in the discussion
  below. Never invent prior rounds, votes, statements, or behavior."
- When the day transcript is empty (round 1, or before anyone has spoken): "This is the start of
  the game. No discussion has happened yet and you have **no** behavioral evidence about anyone.
  Do not reference past behavior — none exists. Base your choice on your role's strategy."

### 4. Inference diversity (`zerog.ts`, mock unaffected)

The reason, speech, and discussion calls are **not signed**, so we vary them freely; the
**signed decision call is left exactly as today** (it only echoes a fixed skeleton, so sampling
is irrelevant and we keep its request identical to preserve the integrity path).

- `InferenceProvider.complete` gains optional sampling params: `{ temperature?, seed? }`.
- For non-signed calls, `Player` passes `temperature ≈ 0.8` and a **per-seat deterministic
  seed** derived from `(matchSeed, seat, round, phase, stage)` so output is varied across seats
  but still reproducible for a given match.
- `ZeroGDirectProvider.complete` forwards these into the request body
  (`temperature`, `seed`) when present; omitting them preserves current behavior.
- The mock provider ignores the params (its output is already deterministic per prompt shape).
- Discussion prompt rule: "React to a specific named player and add one new point — do not
  restate what has already been said."

### 5. Day phase: discuss pass → vote pass (`match.ts`, `types.ts`, `player.ts`)

The night phase is unchanged. The day becomes two ordered passes:

- **Discussion pass.** Each living seat, in seat order, produces one free-form speech, seeing
  the day's prior speeches. **Not signed.** Appended to the public transcript immediately and
  streamed via `onTurn` as it is produced. This is where claims, accusations, and defenses
  happen.
- **Vote pass.** Each living seat sees the **full** day discussion, then produces a short
  public justification + the **signed `vote` Decision** — the existing attested turn. The
  moderator tallies votes exactly as today (`resolveDay`, unchanged).

Mechanics:

- `TurnContext` gains a `stage: "night" | "discussion" | "vote"` discriminator (replacing the
  implicit day/night-from-phase logic where needed). `discussion` turns run **reason→speak**
  only and produce **no** structured decision or attestation; `vote` and `night` turns run the
  full pipeline as today.
- `playMatch` runs the discussion pass (collecting speeches into the transcript) before the
  vote pass within each day. `phaseActors` (or a new day-pass helper) yields discussion actors
  then vote actors.
- `PlayerTurn` / `RecordedTurn`: a discussion turn carries `speech` only (no
  `structuredDecision`/`attestation`). This requires making those fields optional on the
  recorded-turn type, or a separate `DiscussionTurn` variant — chosen at implementation time to
  minimize churn in `toSettlementMove` (which must continue to see only signed decision turns).
- **Night secrecy invariant preserved:** night reasoning is still never broadcast; only day
  discussion + vote justifications enter the public transcript.
- **Streaming / logging:** `onTurn` and `scripts/live-match.mjs` (.md + .json) gain discussion
  turns, clearly labeled as unsigned public speech distinct from the signed vote.
- **Settlement untouched:** only `vote`/`night` turns produce `SettlementMove`s; `toSettlementMove`
  and the on-chain path are unaffected.

## Integrity & invariants (unchanged)

- The signed decision call's request, output format, parsing, and attestation handling are
  identical to today. Sampling params are added **only** to non-signed calls.
- `toSettlementMove` continues to map exactly the signed `night`/`vote` decision turns to
  calldata; discussion speeches never reach it.
- Night reasoning is never broadcast.
- Mocks remain explicitly labeled (`MOCK-local`); no mock is treated as a real attestation.

## Testing

- **Prompt builders (`prompt.test.ts`):**
  - DETECTIVE vote prompt forbids voting a confirmed-TOWN seat and instructs pushing a
    confirmed Mafia; investigate prompt forbids re-investigating known seats.
  - DOCTOR save prompt reasons about likely *kill targets*, not suspicion; references claimed
    power roles.
  - MAFIA kill prompt references claimed power roles and forbids targeting teammates.
  - The FACTS-YOU-KNOW block renders investigations/teammates/history when present, omitted
    when empty.
  - Round-1 / empty-transcript prompts include the "no evidence exists, do not invent" rule.
  - Role-claim guidance present for power roles and Mafia; "claims are not proof" present for
    all.
- **Diversity (`zerog`/`player`):** non-signed calls receive a temperature and a per-seat seed
  that differs across seats for the same turn; the signed decision call's request is byte-for-
  byte unchanged from today.
- **Day phase (`match.test.ts`):** a day yields N discussion speeches (no decisions) followed
  by N signed votes; discussion speeches enter the transcript and are visible to the vote pass;
  night reasoning never enters the transcript; `toSettlementMove` still maps only signed turns;
  existing attestation/settlement bindings still hold.
- **Coherence regression:** the speech↔action coherence invariant from the prior design still
  holds for vote turns (decided target == reasoned target).

## Out of scope

- Model swap (qwen2.5-omni retained; defects are compensated by prompting + diversity).
- Engine/Solidity rule changes.
- Multiple discussion passes or dynamic/condition-terminated discussion (single discussion pass
  only).
- Implementing the IDEA's full deterministic-decoding security property on the signed call
  (tracked under the broader VRF/determinism work, not this rework).
