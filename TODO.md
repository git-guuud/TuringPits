# Turing Pits — Build Plan (AI Mafia)

**Status:** the "Proof of Battle" MVP (Days 1–6) is **shipped and live on 0G Galileo** — the full
loop (watch → wager in CHIP → on-chain settle → claim) runs from the UI. Days 1–7 below are the
historical week plan (kept as a record); the **[Post-MVP roadmap](#post-mvp-roadmap)** at the bottom
is the live to-do list (new market types, more agent personalities, explorer links, SFX, more roles).

**Window (MVP):** Jun 17 → Jun 23, 2026.
**Goal of the week:** an end-to-end demo where judges watch **multiple LLMs play Mafia** live, place
bets on a 0G Chain contract, and see the contract verify the TEE-attested moves and trigger payout —
with the real on-chain mechanics front-and-center.

**Design reference:** `docs/superpowers/specs/2026-06-17-ai-mafia-design.md`.

## Operating rules (from CLAUDE.md)
- One bounded task per session. Don't start the next day until exit criteria pass.
- Mark every mock explicitly as `// MOCK:` / `# MOCK:`. Keep real 0G mechanics real.
- Write tests for new functionality and run them before marking a task done.
- Anything requiring out-of-code action (API keys, faucet funds, infra) goes in
  `myTasks.md` and blocks the dependent task until resolved.
- 0G reference: https://docs.0g.ai/llms.txt

## Critical path
Moderator engine → structured decisions + commit-reveal → 0G Compute TEE players →
0G Storage → Betting + on-chain verifier contract → Frontend → Integration. Compute
(Day 3), Storage (Day 4), and Chain deploy (Day 5) each need credentials/funds — filed in
`myTasks.md` on Day 1 so they don't block mid-week. **The 0G TEE attestation format
(`myTasks.md` §A) gates the on-chain verifier — confirm it before Day 5.**

---

## Day 1 — Jun 17 (Tue): Moderator engine + structured decisions
Stand up the deterministic Mafia moderator and the structured-decision format the contract
will consume. This is the rule spine everything else verifies against.

- [x] Repo layout exists: `engine/`, `contracts/`, `storage/`, `server/`, `frontend/`.
      (`oracle/` to be removed — settlement is on-chain.)
- [x] **Game decided: LLM Mafia** (faction-win market for MVP).
- [x] Implement the moderator in `engine/`: role assignment from a seed, night/day phase
      sequencing, legal-move validation, vote tally, death resolution, win detection.
      Pure function, no LLM, no I/O. (`engine/src/moderator.ts`; 22 passing tests.)
- [x] Define the **structured-decision format** (`{nonce, phase, round, player, action,
      target}`) and its canonical encoding (`encodeDecision`, canonical JSON) — what the
      TEE signs and the contract reconstructs/parses. (`engine/src/encoding.ts`.)
- [x] Remove the `oracle/` package (stub had no reusable helpers; settlement is on-chain).
- [x] **File `myTasks.md`** now: 0G TEE attestation format, Compute access, Storage
      credentials, Chain wallet + faucet + RPC. Prompt me to complete these.

**Exit criteria:** Given a fixed seed and a fixed sequence of structured decisions, the
moderator produces the same per-round state and the same winner, proven by a passing test.
Illegal/out-of-order decisions are rejected. Moderator has zero non-deterministic inputs.

---

## Day 2 — Jun 18 (Wed): 0G Compute TEE players (Bring-Your-Own-Model-ready)
Make the LLM players real and attested. Each turn returns free-form speech plus a signed
structured decision.

- [x] Implement the `players/` abstraction: build the prompt (role + persona + visible
      state), call **0G Compute TEE inference**, parse output into
      `{speech, structuredDecision, attestation}`. Same model for all seats now; one
      interface so each seat can become a distinct model/provider later (BYOM-ready).
      (`players/`: `InferenceProvider`, `Player.takeTurn`, the real Direct-SDK
      `ZeroGDirectProvider` (`zerog.ts`; the earlier Router `ZeroGComputeProvider` was
      removed), `MockLocalProvider` (`# MOCK:`).)
- [x] Drive a full match from the Day-1 moderator using real player calls; capture the
      transcript (speech + decisions + signatures). (`players/src/match.ts` `playMatch`.)
- [x] Validate each attestation locally (signature recovers the provider key over the
      signed bytes) — the same check the contract will do on-chain.
      (`verifyAttestation`, EIP-191 `ecrecover`; 25 tests green. **On mock signer** — live
      TEE attestation gated on `myTasks.md §B`.)

**Exit criteria:** A test runs a full Mafia match end-to-end with TEE-attested player
decisions, every decision carries a valid attestation that verifies locally, and the
moderator declares a winner. Requires Compute access (`myTasks.md`); if unavailable, mark
the inference call `# MOCK:` and flag it — do not fake attestations silently.

---

## Day 3 — Jun 19 (Thu): commit-reveal + 0G Compute hardening
Lock roles against front-running and finalize the inference path. Requires Day-1 creds.

- [x] Implement commit-reveal for the **role assignment**: assign roles from a secret seed
      → `hash(roles + salt)` commit; reveal + verify path confirming `hash(reveal) == commit`.
      (`engine/src/commit.ts`: `commitRoles`/`verifyRoleReveal`/`generateSalt`/
      `roleCommitPreimage`. Commit = `sha256(abi.encodePacked(uint8[] roles, bytes32 salt))`
      — role enums packed in seat order + 32-byte salt, reconstructed on-chain via the
      SHA-256 precompile; 11 tests green. The secret seed is never revealed — only roles+salt.)
- [x] Confirm the live TEE attestation format matches `myTasks.md` §A (scheme = ECDSA,
      exact signed bytes, provider key publication). **CONFIRMED LIVE** (Direct SDK,
      `players/scripts/live-direct.mjs`): EIP-191/ECDSA sig `ecrecover`s to the on-chain
      `teeSignerAddress`; signed bytes = envelope
      `sha256(req):sha256(res):provider_type:provider_identity:tls_fingerprint`. The decision
      encoding is **not** the signed-bytes target — the verifier reconstructs the envelope on
      `responseBody` (SHA-256 precompile + `ecrecover`); Day-5 re-scope recorded in `STATUS.md`.

**Exit criteria:** A test proves commit-reveal accepts the true role assignment and rejects
a tampered one. The signed-bytes format is confirmed compatible with on-chain `ecrecover`
(or the gap is documented and the §6 fallback is queued).

---

## Day 4 — Jun 20 (Fri): 0G Storage — the Evidence Layer
Put player prompts and the transcript on real 0G Storage. Requires Day-1 credentials.

- [x] Integrate 0G Storage SDK (`@0gfoundation/0g-storage-ts-sdk`). Upload each seat's
      public persona before a match; get back the content root. (`storage/src/zerog-storage.ts`
      `createZeroGStorage().upload`; in-memory `MemData`, no temp files. `serializePersonas`
      produces canonical bytes; `root(bytes)` derives the merkle root offline.)
- [x] After a match, upload the full attested transcript (speech + structured decisions + TEE
      signatures); retrieve it back by root. (`serializeMatch` + `download` via
      `downloadToBlob` with merkle-proof verification.)
- [x] Verify round-trip: downloaded bytes hash-equal the uploaded bytes. Live-confirmed on
      0G Storage Galileo testnet (`storage/src/live.test.ts`, guarded by `RUN_LIVE_STORAGE=1`):
      announced root == locally-derived root, and `sha256` of the downloaded bytes equals the
      uploaded bytes for both artifacts. Offline suite (serialization + SDK root) stays green
      with no network/funds.

**Exit criteria:** Player prompts and a transcript are uploaded to 0G Storage and retrieved
by identifier in a test, with a hash check confirming immutability. If credentials aren't
ready, this is blocked in `myTasks.md` — do not mock storage silently; mark any unavoidable
stub `# MOCK:` and flag it.

---

## Day 5 — Jun 21 (Sat): Betting contract + on-chain verifier on 0G Chain
Deploy the on-chain ledger AND the trustless settlement. This is the heaviest single piece.
**DONE** — full on-chain state machine landed; the scope fallback was NOT needed.

- [x] Contract storing: role commit hash, betting open/locked state, YES/NO pools, and a
      settle path gated on on-chain verification. (`MafiaMarket.sol`.)
- [x] Functions: `openMarket(roleCommit, teeSigner, providerMeta, nonce, playerCount)`,
      `placeBet(side)`, `lockBetting()`, `settle(moves, revealedRoles, salt)`, `claim()`.
- [x] `settle()` verifies each move's TEE **envelope** signature (`TeeEnvelope.recover` —
      rebuilds `sha256(req):sha256(res):type:identity:tls_fp` and `ecrecover`s vs the
      registered signer), binds the typed decision to the signed response body, checks
      `sha256(revealedRoles + salt) == roleCommit`, runs the **Mafia state machine in
      Solidity** (`MafiaRules`) to compute the winning faction, and settles.
- [x] Unit tests (local chain) for the full lifecycle + the cheat path (16 Hardhat tests
      green); deployed to 0G Galileo testnet at
      `0xd4d1007585f9bAa44DaBbBCb224a09395F41ca5F` (chainId 16602; bytecode verified).
- [ ] ~~Scope fallback~~ — not needed; the full on-chain state machine landed.

**Exit criteria:** Contract deployed to 0G Chain testnet; a wallet places a bet, betting
locks, an honest match settles with the on-chain-computed winner and the winning side
claims payout. A forged/missing decision signature makes `settle()` revert. Tests cover the
happy path, the cheat path, and reject double-claim / settle-before-lock.

---

## Day 6 — Jun 22 (Sun): Frontend Live Arena + betting UI  ✅ DONE
The gamified spectacle. Clean, polished UI — not a prototype.

- [x] Server-side Sequencer streams each turn over WebSocket (`server/src/orchestrator.ts` +
      `broadcast.ts`; night actions redacted so roles can't leak mid-match).
- [x] Live arena view: the "tribunal" UI — bench/seats, day/night phases, speech & accusation
      feed, live vote tally, deaths, role reveal at sentencing (`components/tribunal/*`).
- [x] Betting panel: connect wallet, YES/NO pools, place a bet, and the full lifecycle
      (open → settled → claimable, plus Draw/Void/Refund) reflected from the contract
      (`components/tribunal/Verdict.tsx`, `state/matchStore.ts`, `lib/contract.ts`).
- [x] Trust story surfaced: role commit shown before betting, roles revealed after the game,
      TEE-attested move count, and a "How it works" primer (`components/tribunal/Record.tsx`,
      `HowItWorks.tsx`).
- [x] **Betting currency → CHIP** (mock ERC20) with an in-app **"Get test tokens"** faucet +
      balance display; market **stays open until settled**; both contracts redeployed (see
      `DEPLOYMENT.md`). Contract suite 49 green.

**Exit criteria (met):** In a browser, a user watches a Mafia match stream turn-by-turn, mints
CHIP, places a bet against the deployed contract, and sees the market settle and a claim
succeed. Every mocked element is visibly labeled (CHIP is the only mock).

---

## Day 7 — Jun 23 (Mon): End-to-end integration + MVP lock  ✅ mostly done
Glue the full loop and harden the demo. No new features — only integration, polish, and the
code-lock snapshot.

- [x] Full happy-path run end-to-end on Galileo: create market (role commit) → CHIP bets →
      match streams (TEE players) → personas + transcript on 0G Storage → contract verifies
      signatures + runs Mafia rules → settles → payout claimed — all from the UI.
- [x] Update `STATUS.md` to reflect completed vs. mocked components honestly.
- [ ] Demo script / runbook so a judge can reproduce the run in minutes.
- [ ] Tag the code-lock snapshot.

**Exit criteria:** A single demo run completes the entire loop with the on-chain mechanics
real and verifiable, the rigging path demonstrably fails to settle, and `STATUS.md`
accurately lists what's real vs. mocked.

---

# Post-MVP roadmap

The MVP loop (watch → wager → settle → claim) is live. Next work is breadth and polish — make the
spectacle richer and the market deeper. Roughly ordered by impact; still one bounded task per session.

### 1. New market types
Today there is one market per match: binary **"does Mafia win?"** (YES/NO parimutuel). Add more
markets keyed to the same `matchId`, settled from the same verified transcript:
- [x] **Per-agent survival** — "does seat N survive to the end?" (one market per seat). Shipped:
      `MafiaMarket` auto-creates one `Survival` prop per seat (`PropKind` enum + `param`, extensible),
      `betPropYes/No` / `claimProp` / `refundProp` mirror the main market, and `_settleProps` resolves
      every prop from the SAME verified run (`g.alive[seat]`) inside the existing `settle()` — no new
      trust, no extra tx. 10 Hardhat tests (survival outcomes cross-checked vs the engine's `alive`
      set; Yes/No/Void/claim/refund). Server reads + pushes prop pools; frontend `SideBets.tsx` lists
      each seat's market in the Verdict rail. Redeployed to Galileo `0xb5bb5394270E0770F62d284eE0bf3802fAD06b41`.
- [x] **Round-of-death** — per-seat over/under on the round a seat is eliminated. Shipped (code-complete;
      **redeploy pending** — batched with per-round "voted out" before the next Galileo deploy). `MafiaMarket`
      auto-creates one `RoundOfDeath` prop per seat (`PropKind.RoundOfDeath`, the second upfront block right after
      Survival: `propIdx == n + seat`, `param == seat`; VotedOut bands follow it), so `propCount == 3 * playerCount`
      at creation. The line is fixed at the opening
      round (`ROUND_OF_DEATH_LINE == 1`): YES = the seat is eliminated in round 1 (the night-1 kill **OR** the day-1
      vote — strictly wider than VotedOut), NO = it lasts past round 1. `MafiaRules` records `deathRound[seat]` (the
      1-based round each seat dies; 0 = survived) in both resolve paths, and `_settleProps` resolves each prop from it
      (`deathRound[seat] != 0 && deathRound[seat] <= line`) inside the SAME verified `settle()` — no new trust, no extra
      tx. betProp/claimProp/refundProp are kind-agnostic so they're reused as-is. The server reads + pushes the third
      prop kind and freezes the RoundOfDeath markets on-chain alongside VotedOut the moment round 1 resolves
      (short-horizon close). Frontend `Verdict.tsx` (per-kind copy) + History list/place/claim each RoundOfDeath market.
      Tests: `MafiaMarket.roundofdeath.test.ts` (creation/betting/settlement/claim/void/close, cross-checked vs the
      engine's per-seat death round) + a `MafiaRules` unit test; full Hardhat suite **79 green**.
- [x] **"Voted out" — recurring per-round market** (was: a one-shot first-vote bet; generalized to re-open
      for EVERY day vote). Shipped (code-complete; **redeploy pending** before the next Galileo deploy).
      `Prop.round` tags the day-vote round a band targets; round 1 is auto-created up front (`PropKind.VotedOut`,
      last upfront block: `propIdx == 2n + seat`, `param == seat`, `round == 1`), and the host floats later
      rounds via the new `openVotedOutRound(matchId)` (onlyOwner) as the match advances, appending an n-seat band
      contiguously at `voIdx(round, seat) == (round+1)*n + seat`. `votedOutRoundsOpened[matchId]` tracks the
      highest opened round (createMatch seeds 1) — so `propCount` GROWS during the match. `MafiaRules.Game`
      records `votedOutRound[seat]` (1-based day-vote round that eliminated it, 0 = never; replaced the old
      `firstVoteElim`/`firstVoteSeat`); `_settleProps` resolves each band by `g.votedOutRound[param] == pr.round`
      inside the SAME verified `settle()` — no new trust, no extra settlement tx. betProp/claimProp/refundProp/
      closeProp are kind/idx-agnostic so they're reused as-is. The server's `syncVotedOutMarkets` opens each
      round's band as the match reaches it and freezes a band once its vote resolves; the live `Verdict.tsx`
      shows only the ACTIVE band (resolved rounds drop to History, which lists/claims every band per round).
      Tests: `MafiaMarket.votedout.test.ts` (creation/`openVotedOutRound`/per-round settlement at n=6/claim/void/
      close) + a multi-round `MafiaRules.votedOutRounds()` cross-check; full Hardhat suite **81 green**.
- Each needs: a market-type tag in `MafiaMarket`, a settle path that derives the outcome from the
  already-verified `MafiaRules` run (no new trust assumptions), and UI to list/place/claim them.

### 2. More agent personalities
The persona pool drives the drama. Deeper, more distinct voices = better television.
- [ ] Expand the curated persona pool well beyond the current set (distinct voices, tactics, tells).
- [ ] Keep them Merkle-rooted/committed so persona governance + prompt-injection resistance hold.
- [ ] Tune prompts per archetype (see [[player-prompt-hallucination-fixes]], [[prompt-probe-fast-loop]]).

### 3. Explorer links in the frontend ✅
Make the on-chain reality one click away (`lib/contract.ts` already has `explorerTx`).
- [x] Link every bet / claim / settle tx hash to the Galileo explorer. (bet/claim via `s.tx.lastHash`
      pre-existed; settle tx now plumbed `settled.txHash` → `ViewState.settleTxHash` → linked in THE
      RECORD and the Verdict panel.)
- [x] Link the market + CHIP token addresses, and the settlement tx, from the live + history views.
      (`explorerAddress`/`explorerToken` helpers; THE RECORD links market + CHIP + TEE signer; the
      History footer links the market contract + CHIP token. Per-match settle-tx in History is the
      one gap — the `matches()` getter doesn't carry it; it lives in the `MatchSettled` event, so a
      per-row deep link would need event-log queries. Deferred; the market-contract link surfaces all
      settles meanwhile.)
- [x] Surface the 0G Storage transcript CID (and persona pool root) as verifiable evidence links.
      (`storageScanFile(cid)` → `storagescan-galileo.0g.ai/files/info?cid=<root>`, StorageScan's own
      file-detail route; the committed bytes32 root IS the StorageScan cid. Links render only when the
      roots are non-zero, i.e. storage is enabled.)

### 4. SFX / audio ✅
Lean into the courtroom-drama theme.
- [x] Move/typing SFX, gavel on verdict, night/day transition stings, a win/lose sting on settle.
      Shipped as procedural Web-Audio stings in `frontend/src/lib/typeSound.ts` (no asset files):
      `gavel` (verdict — fires when the masks fall / `s.reveal`), `nightFall`/`dayBreak` (the day↔night
      lamp swing), `bodyFall` (a seat newly dies — night kill at dawn or a day-vote elimination), and
      `winSting`/`loseSting` (settle, keyed to the spectator's own main-market wager; refund/no-stake
      gets none). Typing SFX (`clickKey`/`bell`) pre-existed. Triggers live in `Court.tsx`, each
      ref-guarded to fire only on a real transition.
- [x] Respect the existing `useMusic`/`typeSound` hooks; per-user mute; no autoplay surprises. The
      stings reuse `typeSound`'s single `AudioContext`, its persisted mute flag (so the existing
      sound toggle — relabeled "sound effects" — covers them), and its first-gesture unlock; every
      emitter no-ops while the context is suspended, so nothing plays before the spectator interacts.
      `useMusic` is untouched. Frontend type-checks + builds clean.

### 5. More roles (stretch)
The engine currently runs MAFIA / DOCTOR / DETECTIVE / TOWN.
- [ ] Add roles (e.g. Jester, Vigilante, Godfather) in `engine/` **and** the Solidity `MafiaRules`
      port + `_checkComposition` in lockstep — they MUST stay byte-for-byte equivalent or settlement
      breaks. Update commit-reveal composition checks and tests on both sides.

### 6. Game-loop drama — make it play like a game, not a slideshow
The mechanics are correct but the loop *feels* flat: night is an opaque poem, the day is a fixed
seat-order round-robin of monologues that never react to each other, and the stage is a single
centered talking head. Guiding principle for everything here: **a betting product needs a legible,
anticipatable causal chain** — the viewer must be able to form a thesis ("Nova's Mafia, she hangs
today"), feel tension about it, and be paid or punished. Each task below exists to make cause →
effect visible and tense, so odds actually move.

**Hard constraints that shape all of these** (do not answer "boring" with "more model calls"): the
0G model is weak/greedy and rate-limited (~10 req/min, token bucket — see [[live-rate-limit-pacing]],
[[game-quality-fallback-cascade-fix]]). The winning pattern is FEWER, more focused, more
dramatically-framed inference calls, plus off-chain presentation that adds drama with ZERO extra
player calls. Recommended execution order: 6.1 → 6.2 → 6.3 → 6.4 → 6.5 → 6.6.

- [x] **6.1 — Visible, consequential night** *(off-chain; shipped 2026-07-02).* The night resolution
      already computed the doctor's save and threw it away, so a blocked kill was mis-narrated as the
      Mafia whiffing (in the 6-player product config, a save is the ONLY way nobody dies). Now the
      engine records a public-safe `lastNight: NightOutcome { round, killed, saved }` on `GameState`
      (`engine/src/moderator.ts` `resolveNight`, `engine/src/types.ts`); the `dawn` wire beat carries
      `saved` as an ANONYMOUS COUNT — never a seat, so the Doctor can't be triangulated
      (`server/src/wire.ts`, `night.ts`, `orchestrator.ts`); and the stage branches three ways —
      a kill landed / a kill was BLOCKED ("A LIFE SHIELDED") / a genuinely quiet night — with a tenser
      nightfall beat (`frontend/src/components/tribunal/Court.tsx` `sceneFor`). Tests: engine (3 night
      outcomes + null-before-night), server (anonymous shielded-count on the wire, no-role-leak invariant
      held). All suites green; server + frontend typecheck clean.
  - [x] **6.1b — Night micro-market** *(descoped from 6.1; code-complete — **redeploy pending**, 2026-07-03).*
        "Who falls before dawn?" — a per-round market that opens at nightfall and freezes at the `dawn`
        beat, so the night's dead zone becomes a betting window. Shipped: a new categorical `PropKind.NightKill`
        on `MafiaMarket.sol` (the night-side twin of `RoundVotedOut`: outcomes = seats + a "no one / all
        spared") auto-created for round 1 (`createMatch` now mints `playerCount + 2` props) and floated per
        later round via the new `openNightKillRound()` (+ `nightKillRoundsOpened` / `NightKillRoundOpened`).
        It resolves inside the SAME verified `settle()` from the already-computed final state — a night kill
        is exactly a round death that was NOT a day vote-out (`g.deathRound[seat] == round && g.votedOutRound[seat]
        == 0`), so no new game state and no new trust. The two recurring kinds now interleave in the prop
        array, so the server/UI address markets by `(kind, param)` (no index formula). Server (`orchestrator.ts`
        `syncRoundMarkets`) opens the NightKill market as the round begins and freezes it at dawn — timing
        pinned by pure `round-markets.ts` predicates (`nightKillResolved`/`votedOutResolved`). Frontend
        `Verdict.tsx` renders the active "Night R kill" market (living seats + "All spared") + History label.
        Tests: `MafiaMarket.nightkill.test.ts` (creation / open / bet / per-round settlement cross-checked vs
        the engine's night deaths, incl. "a vote-out is never a night kill" + quiet-night "no one" + claim /
        void / dawn-freeze) — full Hardhat suite **97 green**; server `round-markets.test.ts` (+10) green;
        server + frontend type-check + build clean. *Exit met* (contract + wiring + coverage); the live
        open→freeze→settle run needs a Galileo redeploy (new bytecode — see `myTasks.md`).

- [ ] **6.2 — Broadcast spine: an AI colour-commentator** *(off-chain; highest feel-per-effort).*
      Add an unsigned narrator/commentator that reacts to the game AND the odds — "The floor's turning
      on Nova, and the money's moving with it. Nobody's seen the doctor's hand yet." It's the connective
      tissue that turns a sequence of beats into a *broadcast* and explicitly ties the spectacle to the
      market. Touches nothing on-chain. New: a server-side commentary generator + a `commentary` wire
      message + a frontend beat, voiced through the existing TTS path (`server/src/tts.ts`,
      `voices.ts`, `frontend/src/lib/useVoice.ts` — see [[tts-sync-and-tag-sanitize]]). Keep it to ~1
      short line at phase boundaries (dawn / vote-lock / settle) so it adds at most a few calls per
      match; it may key off market state (pools) with no player-inference cost at all.
      *Exit:* at each key beat a colour line renders (and voices when TTS is on), reads naturally, and
      references real match state or odds; it never leaks a hidden role; muting/pacing behave like other
      beats; a unit test covers the beat-selection + role-redaction of the commentary line.

- [ ] **6.3 — The day is a *trial*, not a group chat** *(light version: off-chain).* Replace the
      fixed seat-order discussion→vote round-robin (`players/src/match.ts` `playMatch`, ~L251-266) with
      a focused trial spine: a short nomination surfaces a defendant (the seat under most pressure), the
      loudest accuser prosecutes, **the accused gets a rebuttal slot** (the accusation→defense arc that's
      completely missing today), then the bench votes. This focuses the weak model on ONE question per
      beat instead of "say something about the whole table" — the exact trigger for the mode-collapse
      fought in [[day-speech-angle-divergence]]. Light version KEEPS the free-target plurality vote
      (zero contract change) and only reshapes/presents the day; reuse the existing angle/self-defense/
      guard machinery ([[role-strategic-play-prompts]], [[role-rule-guard-layer]]). Frontend: present the
      accused "in the dock" (lean on the existing tribunal vocabulary — Bench/Court/Verdict).
      *Exit:* a day runs as nominate → prosecute → **rebuttal** → vote; the accused's rebuttal renders as
      its own beat; +≤1 inference call vs today; settlement/`MafiaRules` unchanged; `game-probe.mjs`
      shows a real accusation→defense→swing arc; players + frontend suites green.
      *(Full version — guilty/not-guilty vote semantics — touches `MafiaRules.sol` + settlement; queue
      as a separate task under 6.6.)*

- [x] **6.4 — The reveal economy: claims & counter-claims** *(off-chain speech + a new on-chain market;
      code-complete — **redeploy pending**, 2026-07-03).* A **claim** is now a first-class, specially-tagged
      beat: a `claimsDetective` detector (`players/src/sanitize.ts`, precision-tuned + adjacency-anchored so
      it fires on a real reveal / Mafia bluff but not on a negation, hypothetical, third-person, or Doctor
      claim) flags each discussion turn (`DiscussionEntry.claim`, `players/src/match.ts`); the Sequencer
      promotes it to a `claim` wire beat with its own Court scene ("A claim is staked" / "A rival rises"
      on a counter-claim) and floats the **fork the viewer bets on**: a new binary `PropKind.DetectiveClaim`
      market (param = claiming seat, outcomes 0=BLUFF / 1=REAL) opened on the FIRST claim via
      `openDetectiveClaim()`. A Mafia counter-claim renders as its own beat and moves money toward BLUFF on
      the SAME pool — it never spawns a second market. It resolves inside the same verified `settle()` from
      the revealed roles (`g.roles[seat]==DETECTIVE`), so no new game state and no new trust; it stays open
      until settle (roles are hidden mid-match). Wired end-to-end: contract + settlement + hand-written ABIs
      (server+frontend) + orchestrator opener + `Verdict` binary card + History label + `Court`/`Testimony`/
      `Bench` claim scenes. Tests: `MafiaMarket.detectiveclaim.test.ts` (create-on-demand / open-once /
      seat-OOB / owner-only / bet / settle REAL vs BLUFF cross-checked vs roles / claim / void / freeze) —
      full Hardhat suite **109 green**; players `+7` (detector positives/negatives + guard-survival +
      reveal-detection); server relayer owner-only list `+openDetectiveClaim`; a real mock-match e2e run
      confirmed a claim fires and propagates as a flagged entry; `bluff-probe.mjs` now keys off the shared
      detector. Players + server type-check + frontend build clean; no ally leak (claim beat is role-free,
      state redacted). *Exit met* (labeled reveal + counter-claim beats, night-1 investigation intact via the
      existing seat shuffle, probe/detector fire + survive the guard, suites green). The live open→settle run
      needs a Galileo redeploy (new bytecode — same as 6.1b; see `myTasks.md`).

- [ ] **6.5 — Endgame identity ("final table")** *(mostly frontend + a small loop branch).* Round 1
      (everyone blind) and the deciding round (every word is lethal) look identical today. When it
      narrows to 3 seats or Mafia hits parity-minus-one, switch to a "final table": different
      lighting/tempo/music (`Court.tsx` lamp/veil, `useMusic`), and optionally a mano-a-mano showdown
      structure (two accusation speeches, one vote) instead of the trial (`players/src/match.ts`).
      *Exit:* the endgame is visibly distinct (lighting/music/tempo shift on the narrowing threshold),
      is derived from the live alive-count, and doesn't touch settlement; frontend typecheck + probe.

- [ ] **6.6 — North star (contract-touching): the spectacle *is* the market.** The deepest expression
      of the thesis — beat-anchored micro-markets that open and close INSIDE the loop ("convict the
      defendant?", "who dies tonight?" (6.1b), "detective claim: real or bluff?"), so every dramatic
      moment is a betting moment and odds visibly move as speech happens. Plus the **full trial vote
      semantics** (guilty/not-guilty on one defendant) from 6.3, which changes `MafiaRules.sol` +
      settlement. Real contract lift (parimutuel micro-pools with per-beat lifecycle) — treat as the
      roadmap direction, sequenced after the off-chain feel work above proves the drama lands.
      *Exit:* at least one in-loop micro-market opens/settles per dramatic beat from the verified run
      with full Hardhat coverage and no new trust assumptions; UI lists/places/claims it live.

### Deferred / larger bets
- [ ] Slashing contract with host bond + refund-mode compensation payout.
- [ ] Bring-Your-Own-Model: distinct models/providers per seat (GPT vs Claude vs Llama as factions).
- [ ] Production-grade WebSocket scaling and spectator features.
- [ ] Verify contract source on the explorer; consider a real ERC20 / staking currency post-demo.
