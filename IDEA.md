# Turing Pits: Gamified AI Mafia Prediction Market
## Verified Game Engine — Design v2

---

## Overview

**Turing Pits** is a decentralized prediction market where users make live predictions on the outcome of **multiple LLMs playing Mafia** (social deduction). A hidden Mafia minority of AI agents schemes against an uninformed Town majority, debating and voting each other out round by round, while spectators predict who prevails.

The trust model is **pessimistic, fully-verified settlement**: every AI player's decision is generated inside 0G Compute's Trusted Execution Environment (TEE) under deterministic decoding, bound to a verifiable randomness beacon and a monotonic game-state chain. Each move is signed by the TEE provider, and every signature is verified on 0G Chain at settlement. A forged, replayed, re-rolled, or out-of-order move causes settlement to revert.

The platform combines the smooth UX of a Web2 live stream with the trustless guarantees of decentralized infrastructure:
- **0G Compute** runs the AI players under TEE attestation.
- **0G Chain** verifies attestations and settles trustlessly.
- **0G Storage** holds immutable evidence (personas + transcripts).

---

## Strategic Alignment: The Zero Cup Meta

- **Judge Phase (Early Rounds):** Every 0G layer does real work — Compute runs AI players under TEE attestation, Chain verifies attestations and settles via on-chain signature recovery and rule execution, Storage holds personas and transcripts. Not a centralized bolt-on.

- **Community Phase (Late Rounds):** LLMs lying, accusing, and voting each other out is inherently watchable. Verifiable compute wrapped in social-deduction drama is something the public actually wants to watch and vote for.

---

## Core System Architecture

### 1. The Live Arena (Off-Chain Orchestration & UI)

- A Web2 server acts as the **Sequencer**: it drives the deterministic moderator loop and, on each turn, calls 0G Compute to get the active player's decision.
- The moderator is a **pure rule engine** (not an LLM): it sequences night/day phases, validates moves, tallies votes, resolves deaths, and detects win conditions.
- The server streams turns to the frontend over WebSockets at ~1 turn/second: speech, accusations, night kills, vote results.
- **Permissionless mirror:** the live transcript stream is also pushed to a public relay so anyone can independently mirror it, preventing the Sequencer from hiding turns.

### 2. The Market Ledger (0G Chain)

- A prediction-market contract on 0G Chain serves as the decentralized ledger.
- **MVP market: faction win** — a binary YES/NO market on whether Mafia wins.
- **Market mechanism: Parimutuel pool.** All YES stakes form one pool, all NO stakes form another. Winners split the total pot (minus a small protocol fee) pro-rata. This avoids needing an external liquidity provider and guarantees solvency regardless of stake skew.
- **Minimum-liquidity bootstrap:** the host seeds each side with a small symmetric amount (e.g., 10 0G each) so early predictors aren't staking against an empty pool.
- Additional markets (specific-agent survival, round-of-death, etc.) attach to the same match in later versions.

### 3. The Evidence Layer (0G Storage)

- Before any match: each player's **persona/role prompt** is uploaded and content-addressed on 0G Storage; the CID is registered in the contract before predictions open.
- **Persona governance (v1):** personas are drawn from a curated public pool of N pre-audited personas. The pool's Merkle root is hardcoded in the contract. This eliminates prompt-injection attacks via attacker-authored personas.
- **Persona governance (v2):** community-submitted personas pass through a staked review period before joining the pool.
- After the match: full transcript (free-form speech, structured decisions, all TEE signatures, state-chain hashes) is committed to 0G Storage; the CID is recorded on-chain at settlement.

### 4. The Settlement Verifier (0G Compute + 0G Chain)

0G Compute produces trust; 0G Chain consumes it.

- **0G Compute:** every player decision is generated inside a TEE under **deterministic decoding** (temperature=0, fixed top-k=1, fixed seed). The TEE returns the output plus a provider-signed attestation binding:

  ```
  attestation = sign(
      model_id ||
      persona_CID ||
      role ||
      turn_number ||
      prior_state_hash ||
      beacon_value ||
      prompt_hash
      → output
  )
  ```

- **0G Chain:** settlement is fully on-chain. The Sequencer submits the ordered structured decisions, their TEE signatures, the revealed role assignment + salt, and the beacon trace. The contract:
  1. Verifies the role-reveal matches the pre-prediction commit.
  2. For each turn `t`: recovers the TEE signature, checks it against a registered provider key, and verifies `prior_state_hash[t] == hash(state[t-1])` (state-chain continuity).
  3. Checks the beacon value bound into each attestation matches the on-chain VRF output for that turn.
  4. Runs Mafia's rules in Solidity to compute the winning faction.
  5. Pays the parimutuel pool.

- **Any failed check → `settle()` reverts.** No payout on a rigged game.

---

## Security & Anti-Manipulation Mechanics

### Fix 1: State-Chain Binding (prevents re-rolling and selective replay)

Each TEE attestation binds to:
- `turn_number` (monotonic counter)
- `prior_state_hash` (hash of full game state after previous turn)
- `beacon_value` (per-turn VRF output, see Fix 2)

The contract enforces that turn `t`'s `prior_state_hash` equals the hash of the state produced by verifying turn `t-1`. The Sequencer cannot:
- Skip a turn (chain breaks).
- Insert a turn (chain breaks).
- Re-query the TEE with a different history and submit the favorable one (the alternate history produces a different `prior_state_hash`, which the chain rejects).

### Fix 2: Deterministic Inference + VRF Beacon (prevents re-rolling on identical input)

LLM inference is non-deterministic by default. Two valid TEE runs on identical input can produce different outputs, letting the Sequencer re-roll until they like the result.

**Solution:**
- **Deterministic decoding enforced inside the TEE enclave image:** temperature=0, top-k=1, fixed RNG seed. The enclave measurement (which the attestation includes) proves this configuration.
- **Per-turn VRF beacon:** before each turn, the contract emits a VRF output derived from `(match_id, turn_number, prior_block_hash)`. The TEE binds this beacon value into the attestation. Because the beacon is unpredictable until the prior block is finalized, and the TEE refuses to sign without it, the Sequencer cannot pre-run the match or re-roll turns.

### Fix 3: Commit-Reveal for Hidden Roles

- **Commit:** before predictions open, the Sequencer submits `hash(role_assignment || salt)` with a **mandatory ≥256-bit salt** drawn from a contract-emitted entropy seed (preventing grinding).
- **Predictions:** the community predicts while roles remain hidden.
- **Reveal:** at settlement, role assignment and salt are revealed; the contract checks the commit and then checks that each turn's TEE attestation embedded the revealed role for the active player (closing the "role wasn't actually used" gap).

### Fix 4: Multi-Provider TEE Quorum (prevents single-provider collusion)

- The contract registers a **set of K approved TEE provider keys** (K ≥ 3).
- For each turn, the VRF beacon also selects **which provider** runs that turn's inference.
- The Sequencer cannot choose the provider; collusion requires corrupting the specific provider selected by the beacon, which is unknown until the prior block finalizes.
- **v2:** require a 2-of-3 threshold signature per turn for high-stakes matches.

### Fix 5: Block-Height-Enforced Prediction Lock (prevents last-look)

- The role commit transaction also commits to: `betting_open_block`, `betting_close_block`, `match_start_block`.
- The contract refuses predictions outside the window.
- The TEE enclave **refuses to sign turn 1** until `match_start_block` is referenced and its block hash is included in the beacon. The Sequencer cannot pre-run the match before predictions close.

### Fix 6: Permissionless Settlement + Timeout (protects user funds)

- After `match_start_block + match_duration_max`, **anyone** can submit settlement by pulling the transcript from 0G Storage (the Sequencer is required to publish it under a host bond).
- If no valid settlement is submitted by `match_start_block + settlement_deadline`, the contract enters **refund mode**: all predictors withdraw their original stakes. The host bond is slashed and distributed to predictors as compensation for the cancelled match.

### Fix 7: Free-Form Speech Is Also TEE-Signed

Every LLM output — both structured decisions *and* the free-form speech that becomes input to other players' prompts — is part of the attested payload. The Sequencer cannot fabricate flavor dialogue, because that dialogue feeds future turns' `prior_state_hash`. Narrative manipulation is therefore impossible without breaking the chain.

### Fix 8: Persona-Use Verification

Each turn's attestation binds the active player's `persona_CID` and `role`. The contract verifies:
- The `persona_CID` is in the pre-committed pool's Merkle tree.
- The `role` matches the role assigned to that player in the revealed assignment.

This closes the gap where a TEE could be tricked into running with a swapped persona or role.

### Fix 9: Gas-Efficient Settlement via ZK Aggregation (v2 — optional in v1)

Verifying 50+ `ecrecover` calls plus state-machine logic per match is expensive. Two-tier approach:
- **v1 (MVP):** verify each turn's signature on-chain. Acceptable for demo-scale matches (5–7 players, ~20 decisions).
- **v2:** Sequencer submits a single ZK-SNARK proving "I know a sequence of valid TEE signatures forming a continuous state chain that resolves to faction X under Mafia rules." Settlement becomes one verifier call.

### Fix 10: Draw / Stalemate Resolution

- If the moderator's rules produce a draw, **both YES and NO are refunded** (minus protocol fee on the gross pot to cover gas).
- This is encoded in the Solidity Mafia rules so settlement remains deterministic.

### Fix 11: Sybil-Resistant Community Voting (later Cup rounds)

For the public-voting phases:
- Voting weight = `sqrt(0G staked) + prediction_volume_in_past_N_matches`.
- Quadratic weighting on stake reduces whale dominance; prediction-volume term rewards actual platform usage over passive staking.

### Fix 12: Terminology Correction

The system is **not "optimistic."** All settlements are pessimistically verified on-chain. The doc is renamed: **"Verified Game Engine."**

---

## Implementation Status — Enforced Today vs. Designed

> The Fixes above are the **full design**. Not all of them are enforced on the current 0G Galileo
> deploy — this section states exactly what is, so the trust story is honest. The contract's own
> NatSpec says it plainly (`contracts/contracts/MafiaMarket.sol`):
> *"Settlement is trust-MINIMIZED, not trustless… A host that sets a `teeSigner` it controls can
> still fabricate; that residual trust is the product's TEE assumption, not an on-chain guarantee."*

**✅ Enforced on-chain today (verified in `MafiaMarket.settle()` / `MafiaRules` / `TeeEnvelope`):**
- **Per-move TEE signature recovery** — every move's `sha256(req):sha256(res):type:identity:tls_fp`
  envelope is rebuilt on-chain and `ecrecover`ed against the registered signer; a forged move reverts.
- **Decision-bound-to-signed-body** — the typed decision (with the match nonce embedded) is byte-sliced
  out of the signed response body, so a decision can't be swapped or lifted from another match.
- **Move ordering / legality** — `MafiaRules.applyDecision` re-runs the Solidity state machine over the
  submitted moves and **reverts on any illegal, out-of-order, or truncated sequence**. (This is *how*
  Fix 1's goal is met today — by rule re-execution, not by a `prior_state_hash` chain.)
- **Role commit-reveal (Fix 3)** — `sha256(revealedRoles ‖ salt) == roleCommit` with a ≥256-bit salt;
  a tampered/reordered reveal reverts. Free-form **speech is also inside the TEE-signed body (Fix 7)**.
- **Draw / Void refunds (Fix 10)** — encoded as first-class outcomes; stalemate and "nobody backed the
  winner" both refund.
- **Refund timeout (half of Fix 6)** — `enterRefundMode` / `refund` are permissionless once the
  settlement deadline passes, so stuck stakes are always recoverable.

**⚠️ Partial / weaker than the design intends:**
- **Re-roll resistance (Fix 2)** — rests on the TEE's deterministic decoding (temp=0) + host honesty;
  there is **no per-turn on-chain VRF beacon** bound into attestations yet (only a `createMatch`
  `entropySeed`).
- **Persona-use verification (Fix 8)** — the **role** is commit-reveal-bound and checked, but the
  `personaPoolRoot` is stored as an evidence pointer, **not Merkle-verified per move on-chain**.
- **Hidden-match protection (Fix 6)** — the refund-timeout half is enforced, but `settle()` is
  `onlyOwner` (not permissionless) and there is **no host bond / slashing**.
- **Salt grinding** — commit-reveal + a 256-bit random salt are enforced; the salt is client-random,
  not yet *derived from* the on-chain entropy seed.

**📐 Designed, not implemented (v1.1 / v2 roadmap):**
- **Multi-provider TEE quorum + VRF-selected provider (Fix 4)** — a **single host-set `teeSigner`**
  today; this is the largest residual trust assumption.
- **Block-height prediction lock / TEE-refuses-to-sign-before-match-start (Fix 5)** — the testnet provider
  signs on request; predictions currently stay open until `settle()`.
- **Sybil-resistant quadratic community voting (Fix 11)** — no community-vote system exists yet.
- **ZK-aggregated settlement (Fix 9)** — per-move `ecrecover` is used today, as planned for the MVP.

> **Inference/TEE caveat (also in `STATUS.md`):** player inference now runs on **0G mainnet**
> (Aristotle, chainId 16661) on **`qwen3.6-plus`**; the market, CHIP, settlement, and storage stay on
> **Galileo testnet** (16602). The mainnet provider's signed metadata still reports
> `provider_type: centralized, identity: aliyun` with an RA-TLS fingerprint. Per 0G's mainnet TeeML, a
> dstack/**Intel-TDX** serving enclave captures the exact req/res bytes and signs the envelope our
> contract `ecrecover`s — so the operator still **cannot forge, replay, or re-roll a move** (the
> guarantee that matters for predictions). But the **model itself runs on a centralized upstream (aliyun),
> not end-to-end inside the enclave**, and we verify only the signature on-chain, not the TDX
> attestation itself. Honest framing: *moves signed by a TDX-attested (dstack) serving enclave; model
> on a centralized upstream.*

---

## Trust Model Summary

Status legend: **✅ enforced today** · **⚠️ partial** · **📐 designed (roadmap)** — see the section above.

| Attack | Defense | Status (Galileo MVP) |
|---|---|---|
| Sequencer fabricates a move | TEE signature recovery fails → revert | ✅ enforced |
| Sequencer re-rolls until favorable output | Deterministic decoding + VRF beacon binding | ⚠️ determinism assumed; no on-chain beacon |
| Sequencer pre-runs match, then predicts | Match-start block + TEE refuses to sign before block hash | 📐 designed |
| Sequencer skips/reorders turns | State-chain hash continuity check | ✅ enforced via `MafiaRules` re-execution |
| Sequencer swaps persona or role mid-game | Persona CID + role bound into attestation | ⚠️ role bound; persona CID not Merkle-checked |
| Single TEE provider colludes | Multi-provider set + VRF-selected provider per turn | 📐 designed (single `teeSigner` today) |
| Predictor injects prompt via persona | Personas drawn only from curated audited pool | ⚠️ fixed server pool; no on-chain root gate |
| Sequencer hides losing match | Permissionless settlement + host bond + refund timeout | ⚠️ refund-timeout enforced; settle onlyOwner; no bond |
| Whale dominates community vote | Quadratic stake weighting + prediction-volume term | 📐 designed (no community vote yet) |
| Salt grinding to learn roles from commit | Contract-emitted entropy seed forces ≥256-bit unpredictable salt | ⚠️ 256-bit salt enforced; not seed-derived |
| Draw outcome breaks binary market | Explicit refund rule in Solidity Mafia engine | ✅ enforced (Draw + Void) |

---

## Development Roadmap

### June 23 Milestone: "Proof of Battle" MVP — Realistic Scope

- **Game:** 5-player LLM Mafia (2 Mafia, 3 Town) driven by deterministic moderator. Each player decision is a TEE-attested 0G Compute inference under deterministic decoding.
- **Persona pool:** 8 hand-authored personas, Merkle-rooted in the contract.
- **TEE provider set:** 3 registered providers, VRF-selected per turn.
- **State-chain binding:** turn number + prior state hash + VRF beacon in every attestation.
- **Escrow:** parimutuel binary faction-win contract on 0G Chain with commit-reveal and on-chain TEE-signature verification.
- **Evidence:** persona pool CIDs locked pre-match; full transcript + signatures + state hashes stored post-match.
- **Permissionless settlement** + 24-hour refund timeout.
- **Demo flow:** judges watch a Mafia match stream turn-by-turn, place a prediction during the open window, see the contract verify attestations and pay out the parimutuel pool to the winning side.

### Fallback Demo Path

If full TEE integration isn't ready by June 23: ship a **pre-recorded verified match** (real TEE signatures, real on-chain verification, real settlement) with a live prediction overlay on a separately scheduled match window. This preserves all cryptographic guarantees and shifts the "liveness" to v1.1.

### Post-MVP Roadmap

- **v1.1:** ZK aggregation for cheap settlement; additional market types (agent survival, round-of-death).
- **v1.2:** Community persona submissions with staked review.
- **v2.0:** Threshold-signed turns for high-stakes matches; tournament brackets between LLM models (GPT vs Claude vs Llama as factions).
- **v2.1:** Sybil-resistant community vote system for Cup judging integration.

---

## Why This Wins the Zero Cup

1. **Every 0G primitive carries weight.** Remove Compute → no trust anchor. Remove Chain → no settlement. Remove Storage → no audit trail. The architecture cannot be ported to a centralized stack without losing its core property.
2. **TEE-attested inference is exactly what 0G Compute is built for.** The inference *is* the game, and the signature *is* what makes the stream un-riggable.
3. **It's watchable.** LLMs accusing each other of murder is good television. Verifiable compute is the moat; the spectacle is the user acquisition.
4. **The threat model is explicit and the defenses are concrete.** Judges can stress-test the design and find that every attack vector has a named mitigation.

---

*Detailed design: `docs/superpowers/specs/2026-06-17-ai-mafia-design-v2.md`*