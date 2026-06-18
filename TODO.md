# Turing Pits — Week Plan to "Proof of Battle" MVP (AI Mafia)

**Window:** Jun 17 → Jun 23, 2026 (code-lock snapshot due Jun 23).
**Goal of the week:** an end-to-end demo where judges watch **multiple LLMs play Mafia**
live, place bets on a 0G Chain contract, and see the contract verify the TEE-attested moves
and trigger payout — with the real on-chain mechanics front-and-center.

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

## Day 6 — Jun 22 (Sun): Frontend Live Arena + betting UI
The gamified spectacle. Clean, polished UI — not a prototype.

- [ ] Server-side Sequencer streams each turn over WebSocket at ~1 turn/sec.
- [ ] Live arena view: player avatars, day/night phases, speech/accusation feed, vote
      results, deaths.
- [ ] Betting panel: connect wallet, show YES/NO pools, place a bet, see state transitions
      (open → locked → settled → claimable) reflected from the contract.
- [ ] Surface the trust story: role commit shown before betting, roles revealed after the
      game, and a **"TEE-attested by 0G Compute"** badge on each move + on settle.

**Exit criteria:** In a browser, a user watches a Mafia match stream turn-by-turn, places a
bet against the deployed contract, and sees the market settle and a claim succeed. Every
mocked element is visibly labeled as mocked.

---

## Day 7 — Jun 23 (Mon): End-to-end integration + MVP lock
Glue the full loop and harden the demo. No new features — only integration, polish, and the
code-lock snapshot.

- [ ] Full happy-path run: open market (role commit) → bets → lock → match streams (TEE
      players) → prompts + transcript on 0G Storage → contract verifies signatures + runs
      Mafia rules → settles → payout claimed — all from the UI.
- [ ] Demo script / runbook so a judge can reproduce the run in minutes.
- [ ] Update `STATUS.md` to reflect completed vs. mocked components honestly.
- [ ] Tag the code-lock snapshot.

**Exit criteria:** A single demo run completes the entire loop with the on-chain mechanics
real and verifiable, the rigging path demonstrably fails to settle, and `STATUS.md`
accurately lists what's real vs. mocked. Snapshot tagged before EOD.

---

## Deferred past MVP (only after Jun 23 lock)
- Additional markets per match (per-agent survival, "who is voted out next", live AMM).
- Slashing contract with host bond + slippage subsidization payout.
- Bring-Your-Own-Model: distinct models/providers per seat, model-vs-model spectacle.
- Production-grade WebSocket scaling and spectator features.
