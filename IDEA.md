# Turing Pits: Gamified AI Mafia Prediction Market

## Overview

Turing Pits is a decentralized, highly visual prediction market where users place live
bets on the outcome of **multiple LLMs playing Mafia** (social deduction). Instead of
betting on dry real-world events, the platform provides a gamified, live-streaming
spectacle: a hidden Mafia minority of AI agents schemes against an uninformed Town
majority, debating and voting each other out round by round, while spectators bet on who
prevails. The protocol operates as an "Optimistic Game Engine," combining the
buttery-smooth experience of a Web2 live stream with the trustless, verifiable
cryptographic security of the 0G network.

The trust anchor is **TEE-attested inference**: every AI player's decision is generated
inside 0G Compute's Trusted Execution Environment, which signs the result. Because the
inference *is* the game, 0G Compute does exactly what it is built for — and the signature
on each move is what makes the live stream impossible to rig.

## Strategic Alignment: The Zero Cup Meta

This project targets both phases of the 0G Zero Cup:

* **The Judge Phase (Early Rounds):** Evaluators look for complex, native integration of
  decentralized infrastructure. Every 0G layer here does real work for a real reason —
  Compute runs the AI players under TEE attestation, Chain verifies those attestations and
  settles trustlessly, Storage immutably holds the evidence — so the app cannot be
  dismissed as a centralized "bolt-on."

* **The Community Phase (Late Rounds):** From the Quarter-Finals onward, outcomes are
  decided by public voting. LLMs lying, accusing, and voting each other out is inherently
  watchable; wrapping the verifiable compute in that drama ships something the public
  actually wants to watch and vote for.

---

## Core System Architecture

### 1. The Live Arena (Off-Chain Orchestration & UI)

* A Web2 server acts as the **Sequencer**: it drives the deterministic moderator loop and,
  on each turn, calls 0G Compute to get the active player's decision.

* The moderator (pure rule engine) sequences night/day phases, validates moves, tallies
  votes, resolves deaths, and detects the win condition. It is **not** an LLM — only the
  *player decisions* are AI.

* The server streams each turn to the frontend over WebSockets at a locked, suspenseful
  pace (~1 turn/second): player speech, accusations, night kills, and vote results.

### 2. The Market Ledger (0G Chain)

* A betting contract on 0G Chain serves as the decentralized ledger.

* **MVP market: faction win** — a binary YES/NO market on whether Mafia wins. The contract
  is structured so additional markets (e.g. a specific agent surviving to the end) can be
  attached to the same match later.

* Bettors buy YES/NO shares while betting is open; betting then locks before the match runs.

### 3. The Evidence Layer (0G Storage)

* Before any match begins, each player's persona/role prompt is uploaded and locked
  immutably on 0G Storage, so the inputs that produced the game are fixed and auditable.

* After the stream ends, the server commits the full transcript — free-form speech, the
  structured decisions, and every TEE signature — to 0G Storage for public audit.

### 4. The Settlement Verifier (0G Compute + 0G Chain)

0G Compute and 0G Chain split the work that a single "oracle" cannot do alone:

* **0G Compute** produces the trust: every player decision is generated inside a TEE, which
  returns the output plus a provider-signed attestation binding `model + prompt → output`.
  The server cannot fabricate or alter a move.

* **0G Chain** consumes the trust: settlement is **fully on-chain**. To settle, the server
  submits the ordered structured decisions, their TEE signatures, and the revealed role
  assignment. The contract verifies each signature (`ecrecover`) against the registered
  provider key, checks the role reveal against the pre-betting commit, runs Mafia's rules
  in Solidity to compute the winning faction, and pays the winners.

* A forged, missing, or out-of-order decision fails verification and **settlement reverts** —
  nobody is paid on a rigged game.

> Note: the original design routed settlement through 0G Compute re-running an arbitrary
> deterministic script. Verification against the 0G docs showed Compute is strictly for AI
> inference / fine-tuning / training, not general code execution — so that path is not
> possible. On-chain verification of TEE-attested moves replaces it.

---

## Security & Anti-Manipulation Mechanics

### The Hidden-Role Fix: Commit-Reveal

If bettors knew who the Mafia are, faction-win betting would be heavily skewed; and a
server that assigned roles after seeing the betting flow could manipulate outcomes.

* **The Commit:** the moderator assigns roles from a secret seed; the server submits
  `hash(role assignment + salt)` to the contract before betting opens.

* **The Bets:** the community bets while roles remain hidden.

* **The Reveal:** at settlement, the server reveals the role assignment and salt; the
  contract verifies it matches the commit before using the roles. This binds the server to
  a role assignment fixed *before* betting.

### The Failsafe: TEE-Gated Settlement

If the Sequencer tries to rig the stream (force a player to make a move it never produced),
that move will lack a valid TEE signature.

* On-chain verification rejects any move whose signature fails to recover the registered
  provider key.

* With a move missing or forged, the Mafia state machine cannot reach a verified outcome,
  so `settle()` reverts and no payout occurs on a rigged game.

* (Future) A host bond can be slashed and redistributed to bettors when settlement fails
  due to a rigging attempt.

---

## Development Roadmap

### June 23 Milestone: "Proof of Battle" MVP

The first code-lock snapshot requires a working baseline:

* **Game:** LLM Mafia driven by a deterministic moderator, with each player decision a
  TEE-attested 0G Compute inference.

* **Escrow:** the binary faction-win betting contract deployed on 0G Chain, with
  commit-reveal and on-chain TEE-signature verification.

* **Evidence:** player prompts locked on 0G Storage before the match; full transcript and
  signatures stored after.

* **Demo:** a clean frontend where judges watch a Mafia match stream turn-by-turn, place a
  bet, and see the contract verify the TEE-attested moves and pay out the winning side.

> Detailed design: `docs/superpowers/specs/2026-06-17-ai-mafia-design.md`.
