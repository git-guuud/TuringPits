# Game-Quality Session Findings (2026-06-22)

Goal: make the live testnet matches *watchable* — the weak 0G model (`qwen2.5-omni`) "runs nicely but
not much happens." This session diagnosed **why** and fixed it. All changes are in `players/src/`,
all unit tests pass (155 passed, 1 skipped), dist is built. Nothing is committed.

---

## Session 2026-06-23 — day-speech mode-collapse (per-seat rhetorical angles)

**Problem.** Day discussion collapsed onto ONE accusation template, name-swapped per seat (live:
"Juno's sudden shift in stance feels suspicious. She's clearly trying to hide something." / same for
Bram / same for Flint). The echo guard correctly rejected the parroting → ~27–33% of day speeches
regenerated, often re-collapsing to a canned fallback. Root cause: the old generic discussion task was
a MENU ("take a side / name who you suspect / back or challenge a point"), and the greedy model
resolves a menu to its single default — the stock accusation.

**Fix (all in `players/src/`, 218 unit tests pass, dist built):**
- `prompt.ts` **`discussionAngle(ctx)`** (new) — replaces the generic `hasDiscussion` task with ONE of
  6 distinct rhetorical MOVES assigned deterministically by `(seat + round) % 6`: questioner, blunt
  accuser, bandwagon-defender, evidence-demander, peer-builder, contrarian. `ANGLE_COUNT = 6` = the
  product seat count, so within a round every living seat gets a DIFFERENT angle (the assignment is
  injective over consecutive seats) — two seats never get the same instruction at once. Each angle is
  SHORT, POSITIVE, and ENDS on its action command ("Ask it now." / "Build on it now."); the
  present-tense reminder moved BEFORE the angle so the angle is the last thing the model reads.
- `prompt.ts` **`mostSuspected(ctx)`** + **`spokenPeers(ctx)`** (new) — the name-bearing angles
  (questioner/builder → a spoken peer; defender → the pile-on target) draw a CONCRETE target from the
  recent window, turning an open menu into a fill-in-the-template instruction (the one thing this model
  follows). Name-free fallback variants when no suitable peer has spoken yet. Nothing is invented.
- `sanitize.ts` **`ECHO_NOTE`** reworded — the regen now points back to the seat's assigned angle
  ("make the SPECIFIC move the instruction at the end of the prompt asks for, in fresh words") instead
  of the old passive escape ("…or say you have nothing new to add"), which had modelled fence-sitting.
- `sanitize.ts` **`stripForbiddenNameSentences(text, roster, allowed)`** (new, exported) wired into
  `cleanDaySpeech`'s `clean()` step — salvage that drops only a SENTENCE re-accusing a now-DEAD seat
  (the weak model fixates on a player who was prominent the previous day and keeps voting the corpse),
  keeping the clean point. Mirrors `stripMarkedSentences`/`stripEchoedSentences` (no-op without an
  allow-list / single sentence / nothing dropped / too little left → guard rejects as before).
- `prompt.ts` **de-funnel** — three angles originally all said "concrete" (accuser/evidence/builder),
  which FED the model's own "no concrete evidence / gather more evidence" attractor and re-created the
  echo in the vote path. Reworded to distinct vocabulary ("quote the words that worry you", "a real,
  checkable reason", "carry that reasoning one step further"). This was the change that took the regen
  rate to 0.

**Validation — three live N=6 probes (`game-probe.mjs`, GUARD_STATS+GUARD_DEBUG), same fixed seed but
the model is non-deterministic so each produced a DIFFERENT game arc (= generalization evidence):**
- Probe 1 (angles only): day-1 discussion fully diverged (defender / evidence-demander / self-defense /
  contrarian / questioner — no name-swap template), but **30%** regen, now dominated by re-accusing the
  Detective who died night-1 (not echo) → motivated the dead-seat salvage.
- Probe 2 (+ dead-seat salvage): 0 dead-seat rejects (salvage worked), but a longer 3-day game exposed
  **52%** echo concentrated in the vote-case path, amplified by the shared "concrete" vocabulary.
- Probe 3 (+ vocab de-funnel): **0 rejects across the entire game (0% regen)**, discussion diverged in
  BOTH day rounds, Mafia Detective-bluff fired. Mafia win, 10.4 min.

**Carry-forward:** the per-seat ANGLE (deterministic by seat+round, fill-in-template with a concrete
grounded target, ends on the action verb) is the reliable divergence lever for this greedy model —
persona voice alone was not enough. WATCH the model's intrinsic attractor phrases ("concrete evidence",
"weakest link", "gather more evidence"): do not let prompt vocabulary funnel into them or the echo guard
re-collapses the table. The vote-case (`buildVoteSpeechPrompt`) was NOT given per-seat angles (its
target is locked, and endgame convergence on one suspect is legitimate); its echo is now incidental, a
candidate for a future session if a long game's vote rounds prove noisy.

---

## TL;DR — the root cause

Matches were bland **not because the model can't play, but because the moderator guard was rejecting
its real attempts and substituting passive canned fallbacks.** Baseline 6/7-player round-1 discussion
was ~4/6 lines = verbatim `DISCUSSION_FALLBACKS` ("I'm not ready to accuse anyone…"), and every
fallback modelled disengagement, cascading the whole table into fence-sitting.

The new `GUARD_DEBUG=1` env (in `sanitize.ts`) + `players/scripts/guard-diag.mjs` reproduce the
round-1 cascade and print **why** each speech was rejected. Dominant reject causes:
1. **Echo** — the greedy model copies the prior speaker's whole line as a preamble, then adds its
   point; the echo check threw the *whole* thing away.
2. **Forbidden name** — it named a not-yet-spoken seat; the old allow-list rejected that.
3. **Physical-tell fabrication** — "avoiding eye contact", "body language" (impossible in a text game).
4. **Third-person self-reference** — "Cassius has been vocal" when the speaker IS Cassius (this one
   had no marker, so it *leaked* into the transcript as nonsense).

---

## Changes made (all validated live unless noted)

### `players/src/sanitize.ts`
- **`stripLeadingEcho(text, prior)`** (new, exported) — strips a LEADING verbatim copy of a prior
  line so the genuine point after it survives instead of being rejected whole. Wired into
  `cleanDaySpeech`'s `clean()` step. *This was the single biggest salvage.*
- **`refersToSelfInThirdPerson(text, selfName)`** (new, exported) — rejects a speech that narrates the
  speaker in the third person (possessive `Name's`/`Name'` or `Name <is/has/seems/…>`). Self-intro
  "I'm Felix" is allowed.
- **`BAD_SPEECH`** — added physical-tell + night-observation markers: `eye contact`, `body language`,
  `facial expression`, `fidget`, `squirm`, `shifty`, `flinch`, `trembl`, `sweating`,
  `nervous glance/tic/twitch/gesture`, `avoiding eye(s)/gaze`, `gaze`, `night began`,
  `(since|during|throughout) the night`. **Death refs like "during the previous night" are NOT
  matched** (there is a word between "the" and "night") — locked by a test.
- **`MARKER_NOTE`** — rewritten to also forbid invented physical demeanour and say "this is a TEXT
  game — there is no eye contact, body language, tone, or appearance to read."
- **`cleanDaySpeech`** — gained a `selfName` param (9th, defaults `""`, back-compat); the `clean()`
  step now runs `stripLeadingEcho` before `stripSpeakerLabels`; `note()` adds the self-reference note.
- **`accusesClearedTown(text, clearedNames)`** (new, exported) + **`clearedNames`** 10th param to
  `cleanDaySpeech` + **`clearedTownNote`** — the guard that stops a Detective publicly railroading a
  seat it has privately cleared as Town (OPEN ISSUE #1, now resolved). Precision-biased with a
  PROTECTIVE override so vouching is never rejected.
- **`BAD_SPEECH` demeanour/baseline markers** (OPEN ISSUE #2) — `demean(our|or)`, `usual self/
  behaviour/manner/…`, `out of character`, `(hasn't…) been (him/her/them)self`, `acting <manner>`.
  Bare "secretive"/"behaviour"/"usually" deliberately left unblocked. `MARKER_NOTE` no longer names
  "demeanour".
- **`stripMarkedSentences(text)`** (new, exported) wired into `cleanDaySpeech`'s `clean()` step
  (OPEN ISSUE #3 + a general win) — drops only the hallucinated SENTENCE(s) and keeps the clean ones,
  so a strong reveal/bluff wrapped around one bad "evasive tonight" line is salvaged instead of nuked
  to a fallback. Mirrors `stripLeadingEcho`.
- **`sentenceHasBadMarker(s)`** + **`OWN_NIGHT_CLAIM`** (new) — a per-sentence marker test that EXEMPTS
  a bare night word inside a first-person own-investigation claim ("I investigated Boris last night —
  he's Mafia"); the salvage and the day guard's `MARKER_NOTE` branch both route through it, so a real
  reveal / Mafia bluff is no longer nuked for legitimately naming the night. CJK + all other markers
  still count.
- **nervous-family + demeanour `BAD_SPEECH` markers** (OPEN ISSUE #2) — see issue #2 above.
- **`GUARD_DEBUG=1`** env — prints the raw rejected text + the exact reject reason on stderr.

### `players/src/player.ts`
- Removed `spokenNames` / `mentionedNames`; added **`livingNames(ctx)`** — the day-guard allow-list is
  now **ALL LIVING seats** (naming/suspecting any living player is legitimate; fabrication is caught by
  the markers, not the name list). Dead seats stay disallowed; a Detective's investigated (maybe-dead)
  targets stay allowed via `knownNames`. *This + `stripLeadingEcho` killed the cascade.*
- **`DISCUSSION_FALLBACKS` / `VOTE_FALLBACKS`** rewritten from passive ("I'll wait and watch") to
  ACTIVE ("Talk is cheap today. Make a case I can act on…") — so even a fallback pushes the game.
- `discuss()` + `takeTurn()` guard calls now pass `livingNames(...)` as the allow-list and the seat's
  own name as `selfName`.
- **`clearedTownNames(ctx)`** (new) — a Detective's LIVING Town-cleared seat names; `discuss()` passes
  it to `cleanDaySpeech` so the new guard can reject a line that accuses a cleared seat (OPEN ISSUE #1).
- **`discuss()` now runs `namifySeats`** on its output (like the vote path) — no stray "seat N" in a
  discussion line.

### `players/src/prompt.ts`
- **`displayOrder(ctx)`** (new) — presents legal targets in a deterministic per-turn shuffled order so
  the greedy model's "pick the first shown" no longer always lands on **seat 0** (which made seat 0
  always die first and the Detective burn its night-1 investigation on the corpse). Display only;
  `ctx.legalTargets` (validation + fallback) untouched → settlement unaffected. `legalTargetsBlock`
  uses it.
- **De-echoed the tasks** — removed the "quote a few of their words" instruction that was *inducing*
  the echo, in both the discussion reactor task and the vote-speech task; added "in your OWN words,
  never a copy." Tightened the first-speaker task too.
- **`underFire(ctx)`** (new) + **self-defense task** — when another seat's line names THIS seat AND
  carries suspicion language, the discussion task flips to first-person self-defense ("The table is
  turning on YOU…"). Fixes the self-railroad (model agreeing to vote ITSELF out) AND adds drama.
  Task priority: caught-Detective reveal → self-defense → reactor → first-speaker.
- **`MAFIA:vote` rule softened** (per user): "usually steer onto Town, but you MAY sacrifice a
  teammate deliberately for cover — never by accident, keep the vote consistent with the discussion."
  (User: "it's not bad if a mafia votes its teammate to gain others trust." Do NOT hard-block it.)
- **`frameTarget(ctx)`** (new) + **MAFIA bluff branch** in `buildDiscussionPrompt` (OPEN ISSUE #3) —
  from round 2 a Mafia is handed a fake-Detective bluff as its TASK against a concrete non-teammate
  target (accuser → most-suspected → spoken → shuffle); the branch OUTRANKS self-defence. `SUSPICION_RE`
  extracted and shared with `underFire`.
- **Template EXEMPLAR** in the `caught` reveal task and the bluff task — both now SHOW the line to fill
  (`like: "I am the Detective. I investigated <X> and <X> is Mafia — vote <X> out today."`), which is
  what makes a terse persona produce the explicit claim instead of a vague "remove him".

### Tests updated
`sanitize.test.ts` (+stripLeadingEcho, refersToSelfInThirdPerson, physical-tell, salvage, self-ref,
night-observation), `prompt.test.ts` (new task wording, self-defense branch, shuffled-display set
assertion), `match.test.ts` (mock made robust: discussion = any prompt with no "Legal target" line).

### New probe scripts
- **`players/scripts/game-probe.mjs`** — FIXED seed/nonce, dialogue-only full match, NO settlement, so
  it's reproducible across prompt edits and never aborts on a chain issue. Env: `N` (default 7;
  **use `N=6` to match the product**), `SEED`, `NONCE`. Writes `game-<stamp>.md`.
- **`players/scripts/guard-diag.mjs`** — reproduces the round-1 reactor cascade; run with `GUARD_DEBUG=1`.
- **`players/scripts/cleared-probe.mjs`** — FOCUSED check for OPEN ISSUE #1: reconstructs the exact
  17:01 moment (Cleo cleared Esme=TOWN, day-1 discussion, table turning on Esme) and runs ONE live
  `discuss()` with `GUARD_DEBUG=1` to confirm the cleared seat is never accused. ~1–2 calls, not a match.
- **`players/scripts/bluff-probe.mjs`** — FOCUSED check for OPEN ISSUE #3: round-2 Mafia (ally Esme)
  with the table suspecting Dmitri; runs ONE live `discuss()` and reports whether the model authored
  the Detective bluff, framed a non-teammate, and kept the ally hidden. ~1–2 calls.
- **`players/scripts/reveal-probe.mjs`** — FOCUSED check for the real Detective reveal (#1 `caught` +
  the template/night-claim fixes): Esme caught Boris=MAFIA, confirms she authors the explicit
  "I am the Detective. I investigated Boris…" reveal. ~1–2 calls.

Run: `npm run build` (in `players/`) FIRST, then e.g.
`GUARD_DEBUG=1 node --env-file=.env players/scripts/guard-diag.mjs`
`N=6 SEED=0x<hex> NONCE=foo node --env-file=.env players/scripts/game-probe.mjs`

---

## Validation evidence (before → after)

**Round-1 cascade (guard-diag, identical scenario):**
- BEFORE: 4/4 seats = passive fallbacks ("I'm not ready to accuse anyone…").
- AFTER: 2/4 produce real grounded accusations ("I believe Boris should be removed. His comments…
  suggest he's hiding something. Let's vote him out."), the other 2 = ACTIVE fallbacks. No toxic
  non-speaker fabrication leaked.

**Full 7-player game (seed b3, iteration 1):** a Mafia (Cleo) FRAMED a Town player (Felix), the table
bandwagoned, Felix was voted out 4-1, then night kills → Mafia win in **5.5 min**. A genuine arc.

**Physical tells:** "eye contact"/"body language" no longer appear (markers + regeneration note work).

**Seat-0 gravity:** kills/investigations now land on varied seats (the Detective stopped wasting its
night-1 investigation on the about-to-die seat 0).

---

## OPEN ISSUES / NEXT STEPS (prioritized)

1. ✅ **DONE (this session) — Detective accuses a player it has CLEARED.** Observed at 17:01: Cleo
   (Detective) investigated Esme → **TOWN**, then in discussion *accused* Esme ("today's vote should
   focus on Esme… she's hiding something… vote her out") — inverting its own certain knowledge.
   The prior session had added the `buildDiscussionPrompt` *vouch* branch (a Detective with cleared-Town
   results but no caught Mafia gets a "never accuse the cleared seat, redirect/defend instead" task,
   tested in `prompt.test.ts`) **but the weak model ignored that conditional prompt** — so the bug
   still fired live. The reliable fix, added this session, is a **guard layer** (the same pattern as
   every other hallucination class):
   - `sanitize.ts` **`accusesClearedTown(text, clearedNames)`** (new, exported within the package) —
     returns the cleared names a Detective's day line pushes the vote onto / casts suspicion on. It is
     sentence-scoped with a **PROTECTIVE override** (innocent / trust / vouch / clean / negation), so a
     genuine vouch or defence ("Esme is innocent — look at Boris instead") is NEVER rejected. Biased to
     **precision** (a false reject only costs a safe fallback; a miss railroads an innocent). Catches
     `vote/focus/target X`, `X is/really is/'s … suspicious/hiding/mafia/…`, and `X should go / out today`.
   - `sanitize.ts` `cleanDaySpeech` gained a 10th `clearedNames` param + a `clearedTownNote` correction.
   - `player.ts` **`clearedTownNames(ctx)`** (new) — a Detective's LIVING Town-cleared names; passed by
     `discuss()` only (the vote pass is left to the `DETECTIVE:vote` rule, which already bars voting a
     confirmed-Town, and whose fallback names the chosen target — see residual note below).
   - Tests: `sanitize.test.ts` (+7: detector incl. the exact 17:01 line & the adverb-gap "really is"
     case, vouch/defence/mention negatives, sentence-scoping, multi-name; guard integration reject→retry,
     retry-still-dirty→fallback, vouch-untouched), `player.test.ts` (+2: `discuss()` never lets a
     Detective accuse a cleared seat → safe fallback; a vouch+redirect passes untouched). 166 pass.
   - Live (`players/scripts/cleared-probe.mjs`, new — reconstructs the exact 17:01 moment, 1–2 calls):
     in BOTH the neutral and the harder "table already turning on Esme" cascade, Cleo now **redirects
     to Boris and never accuses cleared Esme**. Outcome is correct by construction — the guard makes
     accusing a cleared seat in discussion impossible regardless of what the model emits.

   *Residual (minor):* the guard is **discussion-only**. The vote-speech path isn't guarded because its
   fallback names the chosen target, and a target that is itself a cleared seat is a *vote-choice* bug
   (out of scope — the `DETECTIVE:vote` rule handles it). Also, the precision bias means a rare inverted
   phrasing where the cleared seat is the *suspecter* ("Esme is suspicious **of** Boris") could trip a
   needless fallback — acceptable given the asymmetric costs.

2. ✅ **DONE (this session) — "demeanour" vibe-fabrication leak.** Added to `BAD_SPEECH`:
   `\bdemean(?:our|or)\b`, `usual\s+(?:self|behavio(u)?r|demean(our|or)|manner|temperament|tone)`,
   `out of character`, `(hasn't|isn't|…) been (him|her|them|it)self`, and `acting\s+(?:<adverb>\s+)?`
   `(secretive|strange|odd|weird|cagey|defensive|shady|sketchy|paranoid|guilty|fishy|suspicious|`
   `nervous|different…)`. Per the original note, **bare "secretive" / "behaviour" / "usually" are NOT
   blocked** (precision — they can be legit reads), locked by a "does NOT over-block" test. `MARKER_NOTE`
   reworded so it no longer NAMES "demeanour" (which would induce the model to echo it on regen).
   Crucially this composes with the new salvage (below): a fabricated "his demeanour is off" sentence is
   now DROPPED in-place, not nuked-to-fallback. Tests: `sanitize.test.ts` (+2 it-blocks, incl. the exact
   17:01 line and the over-block negatives).

3. ✅ **DONE (this session) — Mafia fake-ROLE-claim bluff now fires.** Two parts, both needed:
   - **It fires:** `prompt.ts` `frameTarget(ctx)` (new) picks a living non-teammate to frame —
     preferring a seat that is actively ACCUSING this Mafia (so the bluff coherently turns the heat
     back: "I'm the Detective and MY accuser is the Mafia"), else whoever the table suspects most,
     tie-broken by who-has-spoken then the per-turn shuffle; never a teammate; null if only allies
     remain. A new `buildDiscussionPrompt` MAFIA branch (round ≥ 2) makes the bluff the TASK. The key
     lever is a **fill-in template EXEMPLAR**, not a description: the task literally shows
     `like: "I am the Detective. I investigated <X> and <X> is Mafia — vote <X> out today."` Describing
     the parts ("reveal you are the Detective…") produced a VAGUE line on terse personas (live: Esme →
     "today's vote should focus on removing him"); the exemplar made it crisp across personas (live:
     Esme → "I am the Detective. I investigated Boris and Boris is Mafia — vote Boris out today."). The
     SAME exemplar fix was applied to #1's `caught` Detective-reveal task. Priority: caught → **bluff** →
     self-defence → clearedTown → reactor → opener. The bluff OUTRANKS self-defence on purpose: a Mafia
     is usually under some suspicion by round 2, so gating it behind "not under fire" left it dormant in
     real games — and claiming Detective (framing the accuser) IS the strongest defence when cornered.
   - **It SURVIVES:** the bluff first got nuked because the model appended one fabricated sentence
     ("he's been evasive tonight"), which the all-or-nothing guard rejected → fallback. Fixed by
     **`sanitize.ts` `stripMarkedSentences`** (new) — drops only the marked sentence(s), keeps the
     clean reveal/bluff (mirrors `stripLeadingEcho`; wired into `cleanDaySpeech`'s `clean()` step).
   - **Night-claim exemption** (`sentenceHasBadMarker` + `OWN_NIGHT_CLAIM`, new) — a power-role
     legitimately cites the night when claiming its OWN investigation ("I investigated Boris last night
     — he's Mafia"). The flat `tonight`/`last night` ban was nuking the very claim sentence; now a bare
     night WORD inside a first-person investigation/role claim is exempt (every other marker still
     counts). Both the salvage and the day guard route through it. This is what lets a reveal/bluff that
     bundles the night reference into the claim survive intact.
   - Tests: `prompt.test.ts` (+6: bluff fires/names suspect, never the ally, no round-1 bluff,
     bluff-outranks-fire + round-1 fallback, exemplar present), `sanitize.test.ts` (+8: salvage, the
     night-claim exemption unit + integration), `player.test.ts` (+1: discussion `namifySeats`).
   - Live (`players/scripts/bluff-probe.mjs` + `reveal-probe.mjs`, new): round-2 Mafia and a
     caught-Detective both author the full crisp claim, the ally is never leaked, salvage + night-claim
     exemption keep the line intact.

   *Residual (minor):* the weak model sometimes frames a non-teammate SPEAKER instead of the silent
   seat the template named (it gravitates to visible participants) — still a valid, ally-safe frame,
   just not always the most-suspected one. Per `mafia-teammate-vote-strategic`, a Mafia accusing its
   own ally is NOT hard-blocked (it can be cover play), so the "never name an ally" line is guidance,
   not a guard.

   *Bonus fix (general, not #1–3):* `player.ts` `discuss()` now runs `namifySeats` on its output like
   the vote path already did — a stray "insights on seat 2" in a discussion line read as a bug.

4. **Provider 2000 tokens/min limit is REAL and binding** (contradicts the older `live-rate-limit-pacing`
   note — now corrected in memory). Sustained back-to-back calls hit `429 "limit: 2000 tokens/min"`
   with waits growing 0→8→13→20s. The `zerog.ts` `withRetry` ABSORBS each one (no crash) but games
   **crawl** when it's active (~2.5 calls/min ceiling at ~800 tok/call). It's intermittent (some games
   never hit it). **Do NOT re-add a proactive token throttle** (it historically over-throttled 4.5×);
   the reactive retry is fine — just know demos can be slow.

5. **Deterministic fallback still picks `legalTargets[0]` (seat 0)** on a reason-call parse failure
   (the `displayOrder` shuffle only affects the MODEL's pick, not the fallback). Minor — only on
   failures, and a death still lands. Could align the fallback to `displayOrder[0]` if desired.

6. **7+-player (2-Mafia) deathless night.** When the two Mafia SPLIT their kill, `plurality()` returns
   `null` → no death → stalled night. The split is *model-driven* (one Mafia reasons to a different
   target), so display-order tricks don't fix it. **The PRODUCT runs 6 players = 1 Mafia**
   (`server/src/index.ts` `PLAYER_COUNT ?? 6`), where ties are impossible — so this only matters if
   the demo ever goes to 7-8. **Real fix:** break the kill tie deterministically in BOTH the TS engine
   (`engine/src/moderator.ts` `plurality`/night resolution) AND the Solidity mirror, or have only one
   Mafia submit the kill — an engine+contract change, out of scope this session.

7. **Doctor save reasoning sometimes just echoes the persona blurb** verbatim (private, cosmetic).

---

## Key facts to carry forward
- The model is effectively **greedy/deterministic** (ignores seed/temperature), **degrades on long
  prompts**, and **echoes any "bad" word the prompt names** — so anti-hallucination rules must be
  SHORT, POSITIVE, end on the action command, and never name the forbidden word.
- **Always `npm run build` in `players/` before running any probe** — they load the built `dist`, not
  `src`; rebuilding mid-run does NOT affect an already-running process (it cached dist at startup).
- Product player count = **6** (1 Mafia). 7-player (2 Mafia) is more dramatic but has the split-kill
  caveat above.
- Composition (`engine/src/moderator.ts`): 5–6 = 1 Mafia, 7–8 = 2 Mafia.
- The relevant memories: `game-quality-fallback-cascade-fix`, `mafia-teammate-vote-strategic`,
  `live-rate-limit-pacing` (token-limit correction), `role-strategic-play-prompts`,
  `player-prompt-hallucination-fixes`, `prompt-probe-fast-loop`.
