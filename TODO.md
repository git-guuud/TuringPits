# Turing Pits — Week Plan to "Proof of Battle" MVP

**Window:** Jun 17 → Jun 23, 2026 (code-lock snapshot due Jun 23).
**Goal of the week:** an end-to-end demo where judges watch a deterministic AI-vs-AI
match stream live, place bets on a 0G Chain contract, and see 0G Compute verify the
match and trigger payout — with the real on-chain mechanics front-and-center.

## Operating rules (from CLAUDE.md)
- One bounded task per session. Don't start the next day until exit criteria pass.
- Mark every mock explicitly as `// MOCK:` / `# MOCK:`. Keep real 0G mechanics real.
- Write tests for new functionality and run them before marking a task done.
- Anything requiring out-of-code action (API keys, faucet funds, infra) goes in
  `myTasks.md` and blocks the dependent task until resolved.
- 0G reference: https://docs.0g.ai/llms.txt

## Critical path
Engine → Battle log + commit-reveal → 0G Storage → Betting contract → 0G Compute
oracle → Frontend → Integration. Storage (Day 3), Contract (Day 4), and Compute
(Day 5) each need credentials/funds — file those in `myTasks.md` on Day 1 so they
don't block mid-week.

---

## Day 1 — Jun 17 (Tue): Scaffold + deterministic game engine core
Stand up the repo structure and the 100%-deterministic match engine. This is the
spine everything else verifies against, so determinism is the only thing that matters
today.

- [ ] Initialize repo layout: `engine/`, `contracts/`, `storage/`, `oracle/`,
      `frontend/`, `server/`. Add `git init`, README stubs, package manifests.
- [ ] Pick the game format (recommend: a simple, fully-deterministic format with a
      small move set — e.g. a constrained chess variant or a deterministic grid
      duel — so 0G Compute can re-run it instantly with no external calls).
- [ ] Implement the engine: `seed + agentA + agentB -> sequence of moves -> winner`.
      No wall-clock, no RNG except the seeded PRNG, no I/O. Pure function.
- [ ] Define two simple baseline agent scripts (deterministic policies).
- [ ] **File `myTasks.md`** now: 0G testnet wallet + faucet funds, RPC endpoint,
      0G Storage credentials, 0G Compute access. Prompt me to complete these.

**Exit criteria:** Running the engine twice with the same `(seed, agentA, agentB)`
produces byte-identical move sequences and the same winner, proven by a passing
test. Engine has zero non-deterministic inputs.

---

## Day 2 — Jun 18 (Wed): Battle log + commit-reveal + replay verifier
Make the match producible AND independently re-checkable, and lock the seed against
front-running. This is the cryptographic heart of "Proof of Battle".

- [ ] Serialize each match to a canonical text battle log (PGN-style for chess, or a
      defined line format) with a per-move hash and a final log hash.
- [ ] Implement commit-reveal for the seed: generate secret seed → hash it → store
      commit; reveal + verify path that confirms `hash(reveal) == commit`.
- [ ] Implement the **replay verifier**: given `(revealed seed, agent scripts, battle
      log)`, re-run the engine and assert the regenerated move hashes match the log
      hashes. This is exactly what Day 5's oracle will run.

**Exit criteria:** A test proves (a) commit-reveal accepts the true seed and rejects a
tampered one, and (b) the verifier returns PASS for an honest log and FAIL when any
single move in the log is mutated.

---

## Day 3 — Jun 19 (Thu): 0G Storage — the Evidence Layer
Put agent scripts and the battle log on real 0G Storage. Requires Day-1 credentials.

- [ ] Integrate 0G Storage SDK. Upload the two agent scripts before a match and get
      back content identifiers / root hashes.
- [ ] After a match, upload the final battle log; retrieve it back by its identifier.
- [ ] Verify round-trip: downloaded bytes hash-equal the uploaded bytes.

**Exit criteria:** Agent scripts and a battle log are uploaded to 0G Storage and
retrieved by identifier in a test, with a hash check confirming immutability. If
credentials aren't ready, this is blocked in `myTasks.md` — do not mock the storage
layer silently; if a stub is unavoidable, mark it `# MOCK:` and flag it.

---

## Day 4 — Jun 20 (Fri): Betting contract (escrow) on 0G Chain
Deploy the on-chain ledger that holds bets and pays winners. Keep it minimal for MVP:
a binary YES/NO escrow per match with seed-commit storage; full AMM/slashing can be
scoped down to escrow + payout for the MVP.

- [ ] Contract storing: seed commit hash, betting open/locked state, YES/NO pools,
      and a settle function gated on an oracle-verified outcome.
- [ ] Functions: `openMarket(commitHash)`, `placeBet(side)`, `lockBetting()`,
      `revealSeed(seed)`, `settle(winner, oracleSig)`, `claim()`.
- [ ] Unit tests (local chain) for the full lifecycle, then deploy to 0G Chain
      testnet and record the address.

**Exit criteria:** Contract deployed to 0G Chain testnet; a test wallet can place a
bet, the market locks, settles with a winner, and the winning side claims a payout.
Tests cover the happy path and reject double-claim / settle-before-lock.

---

## Day 5 — Jun 21 (Sat): 0G Compute — the Settlement Oracle
Wire the Day-2 verifier into 0G Compute so verification is the trustless trigger for
on-chain settlement.

- [ ] 0G Compute job that pulls battle log + agent scripts + revealed seed from 0G
      Storage and runs the deterministic replay verifier in isolation (no external
      API calls).
- [ ] On PASS, produce a signature/attestation over the verified outcome; on FAIL,
      refuse to sign (this is the slashing trigger — minimal version: just withhold
      the signature so settle reverts).
- [ ] Push the attestation to the Day-4 contract's `settle()`.

**Exit criteria:** An honest match runs through Compute → produces a valid signature →
contract settles and pays out. A tampered battle log produces NO signature and the
contract cannot settle. Both paths shown by a test.

---

## Day 6 — Jun 22 (Sun): Frontend Live Arena + betting UI
The gamified spectacle. Clean, polished UI — not a prototype.

- [ ] Server-side Sequencer streams calculated moves over WebSocket at 1 move/sec.
- [ ] Live arena view renders the match as it streams (board/grid + move feed).
- [ ] Betting panel: connect wallet, show YES/NO pools, place a bet, see state
      transitions (open → locked → settled → claimable) reflected from the contract.
- [ ] Surface the trust story in the UI: commit hash shown before betting, seed
      revealed after lock, "Verified by 0G Compute" badge on settle.

**Exit criteria:** In a browser, a user watches a match stream move-by-move, places a
bet against the deployed contract, and sees the market settle and a claim succeed.
Every mocked element is visibly labeled as mocked.

---

## Day 7 — Jun 23 (Mon): End-to-end integration + MVP lock
Glue the full loop and harden the demo. No new features — only integration, polish,
and the code-lock snapshot.

- [ ] Full happy-path run: open market (commit) → bets → lock → reveal → match streams
      → log + scripts on 0G Storage → 0G Compute verifies → contract settles → payout
      claimed — all from the UI.
- [ ] Demo script / runbook so a judge can reproduce the run in minutes.
- [ ] Update `STATUS.md` to reflect completed vs. mocked components honestly.
- [ ] Tag the code-lock snapshot.

**Exit criteria:** A single demo run completes the entire loop with the on-chain
mechanics real and verifiable, the divergence/cheat path demonstrably fails to settle,
and `STATUS.md` accurately lists what's real vs. mocked. Snapshot tagged before EOD.

---

## Deferred past MVP (only after Jun 23 lock)
- Full AMM (continuous buy/sell of shares) replacing binary escrow.
- Slashing contract with host bond + slippage subsidization payout.
- Multiple game formats / BYOA agent upload flow.
- Production-grade WebSocket scaling and spectator features.
