# Turing Pits — Build Plan (AI Mafia)

**Status:** the "Proof of Battle" MVP (watch → wager in CHIP → on-chain settle → claim) is **shipped
and live on 0G Galileo**. What's built, deployed, and mocked lives in `STATUS.md` — this file is the
**forward to-do list only** (completed work has been moved out). Security-hardening work has its own
file: `SECURITY.md`.

**Design reference:** `docs/superpowers/specs/2026-06-17-ai-mafia-design.md`.
**0G reference:** https://docs.0g.ai/llms.txt

## Operating rules (from CLAUDE.md)
- One bounded task per session. Don't mark a task done until its exit criteria pass.
- Mark every mock explicitly (`// MOCK:` / `# MOCK:`). Keep real 0G mechanics real.
- Write tests for new functionality and run them before marking a task done.
- Out-of-code actions (API keys, faucet funds, infra, redeploys) go in `myTasks.md` and block the
  dependent task until resolved.

---

## Pending Galileo redeploy
Several finished features are code-complete + test-green but **not yet on-chain** — they need one
batched redeploy (new bytecode, fresh Galileo deployment; see `myTasks.md` / `STATUS.md`). Fold the
contract-touching Security tasks into the same redeploy where possible:
- [ ] Night micro-market — "who falls before dawn?" (`PropKind.NightKill`, was §6.1b).
- [ ] The reveal economy — detective-claim market (`PropKind.DetectiveClaim`, was §6.4).
- [ ] Recurring per-round side markets — round-of-death + per-round "voted out".
- [ ] EIP-2771 gasless relayer + `Forwarder` (also needs a funded relayer wallet).

---

# Post-MVP roadmap
Breadth + polish — make the spectacle richer and the market deeper. Roughly ordered by impact; still
one bounded task per session. (Completed roadmap sections — new market types, explorer links, SFX —
now live in `STATUS.md`.)

### Betting UX — fewer wallet pop-ups (session keys)
The signing pop-up on every wager was the sharpest friction. **Option 1 shipped** (frontend-only, this
session): an in-browser **session key** is the on-chain bettor and signs relayed `ForwardRequest`s
LOCALLY (no pop-up); the existing EIP-2771 relayer pays gas, so the key never needs native 0G. Two ways
to obtain it — both pop-up-free after setup:
- [x] **Derived session** — one `personal_sign("TuringPits session v1")` by the injected wallet seeds a
      deterministic key (`keccak256(sig)`), cached per-owner in localStorage → one pop-up ever.
      (`frontend/src/lib/contract.ts` `connectSessionWallet` / `sessionKeyFromSignature`.)
- [x] **Guest burner** — a pure random in-browser key for no-wallet / won't-sign visitors, persisted and
      silently restored on return (`connectBurnerWallet` / `restoreBurnerWallet`). No server/contract
      change: the relayer already sponsors `betProp/claimProp/faucet/approve` for any signer, and a session
      sig recovers to `req.from` so `Forwarder.verify()` passes (verified in `.session-check.mjs`).
      *Caveat:* a session/guest wallet holds no 0G, so it can bet ONLY while the relayer is live+funded
      (`withGasless` forces the relay path and errors clearly if it's offline — no silent gas fallback).

Deferred — the two "proper" account-abstraction upgrades, if the browser-key trust model is ever too weak
(e.g. real-value stakes instead of mock CHIP):
- [ ] **Option 2 — ERC-4337 smart account + scoped session key.** User's smart wallet grants a session
      key scoped to the market with spend/time limits; the dApp signs userOps silently. The "proper"
      answer, but heavy: needs a bundler + paymaster + account factory, and it largely re-implements what
      the Forwarder/relayer already do. Reach for it only if positions must live on the user's *main*
      account with on-chain-enforced limits.
- [ ] **Option 3 — EIP-7702 delegation.** The EOA delegates to a contract that authorizes a session key —
      lighter than 4337, keeps the user's own address as the bettor. Blocked on verifying wallet + 0G
      Galileo support for `SET_CODE_TX_TYPE` (0x04); confirm before committing.

### 2. More agent personalities
The persona pool drives the drama. Deeper, more distinct voices = better television.
- [ ] Expand the curated persona pool well beyond the current set (distinct voices, tactics, tells).
- [ ] Keep them Merkle-rooted/committed so persona governance + prompt-injection resistance hold.
- [ ] Tune prompts per archetype (see [[player-prompt-hallucination-fixes]], [[prompt-probe-fast-loop]]).

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
player calls. Remaining execution order: 6.2 → 6.3 → 6.5 → 6.6. (6.1 / 6.1b / 6.4 done — see `STATUS.md`.)

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
- [ ] Host bond + slashing + refund-mode compensation payout → tracked in `SECURITY.md` §S6.
- [ ] Bring-Your-Own-Model: distinct models/providers per seat (GPT vs Claude vs Llama as factions).
- [ ] Production-grade WebSocket scaling and spectator features.
- [ ] Verify contract source on the explorer; consider a real ERC20 / staking currency post-demo.
