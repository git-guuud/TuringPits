# Turing Pits — AI Mafia Design Spec

_Date: 2026-06-17_
_Status: Approved design, pre-implementation_
_Supersedes: the deterministic AI-vs-AI (chess) framing in the original `IDEA.md`._

## 0. Why this pivot

The original design routed settlement through **0G Compute re-running an arbitrary
deterministic script** (re-simulate a chess match, hash-match the moves, sign the
result). Verification against the 0G docs showed this is **not possible**: 0G Compute
is a GPU marketplace strictly for **AI inference / fine-tuning / model training**, not
general-purpose code execution. A consumer cannot hand it a chess engine to run.

What 0G Compute *does* offer natively is **TEE-attested inference**: every provider runs
inside a Trusted Execution Environment, generates a signing keypair at startup, and
produces "verifiable, on-chain proof of execution" plus downloadable Remote Attestation
reports.

AI Mafia is engineered around that real capability. The game is played by **LLMs**, so
inference *is* the game — and the TEE signature on each inference is the trust anchor.

## 1. Concept

Multiple LLM "players" play **Mafia** (a.k.a. Werewolf): a hidden **Mafia** minority vs
an uninformed **Town** majority, over alternating **night** (Mafia secretly kill) and
**day** (everyone discusses, then votes to eliminate one player) phases. Town wins when
all Mafia are eliminated; Mafia wins on reaching parity with Town.

Spectators bet on the outcome via a 0G Chain market while the match streams move-by-move
over WebSocket. The platform is the "Optimistic Game Engine" reframed: a Web2-smooth live
stream whose integrity is cryptographically anchored to 0G.

Standard match size for MVP: **5–7 players, 1–2 Mafia.**

## 2. Trust model: TEE-attested inference

The match is **non-deterministic** (LLM sampling), so the old "re-run and hash-match"
verification is gone. Instead:

- Every player decision is generated inside **0G Compute's TEE**.
- The TEE returns the output **plus a provider-signed attestation** binding
  `model + prompt → output`.
- The server therefore **cannot fabricate or alter a move** — a move without a valid TEE
  signature is rejected at settlement.

The deterministic **moderator** (rule engine) turns the sequence of attested decisions
into a winner; Mafia's rules are simple enough to also encode in Solidity for trustless
settlement (see §6).

## 3. The two-layer turn (key architectural decision)

Each player turn produces **two artifacts**:

1. **Free-form speech / reasoning** — natural-language chatter ("I think player 3 is
   lying…"). Streamed to the UI for the spectacle; stored on 0G Storage. **Not
   load-bearing for settlement.**
2. **A structured decision** — a constrained payload the contract can parse, e.g.
   `{"phase":"day-vote","player":2,"action":"vote","target":3}` (enum action + integer
   target). **This is what the TEE signs and what the Solidity state machine consumes.**

Rationale: free text cannot be parsed reliably or cheaply on-chain; a structured enum can.
The transcript on 0G Storage lets anyone audit that the free-form play and the structured
decisions are consistent.

> **Verification dependency (see §10):** this assumes we control *what bytes* the TEE
> signs (ideally the canonical structured-decision payload). If the TEE only signs a fixed
> request/response envelope, the contract must reconstruct/verify that envelope hash
> instead — confirm before building the on-chain verifier.

## 4. The four 0G layers

| Layer | Role | Real / mocked |
|---|---|---|
| **0G Compute** | TEE-attested LLM inference for each player decision. Returns `{output, attestation}`. | Real (gated on credentials) |
| **0G Chain** | Betting escrow **+ fully on-chain settlement**: verify each move's TEE signature (`ecrecover`), check commit-reveal, run Mafia rules in Solidity, compute winner, pay out. | Real |
| **0G Storage** | Pre-match: lock player persona/role prompts (immutable, content-hashed). Post-match: store full transcript (speech + structured decisions + all TEE signatures) for public audit. | Real |
| **0G DA** | Not used in MVP. Noted as future. | N/A |

## 5. Betting market

- **MVP: faction win** — a single binary YES/NO market: *does Mafia win?* Maps directly
  onto the existing binary escrow contract.
- **Designed for extension:** the contract is structured so additional market types
  (per-agent survival, "who is voted out next", etc.) can be added later **without
  reworking the escrow core**. Multiple markets may attach to one match.
- One market settles once, at game end, from the on-chain-computed winner.

## 6. Settlement: fully on-chain, trustless

Settlement does **not** use a separate Compute oracle (Compute can't run the moderator
code). It lives in Solidity:

1. The server submits, in the `settle` transaction:
   - the ordered list of **structured decisions**,
   - each decision's **TEE signature**,
   - the **revealed role assignment + salt**.
2. The contract:
   - checks `hash(roles + salt) == committed hash` (commit-reveal, §7),
   - for each decision, `ecrecover`s the TEE signature and confirms it matches the
     **registered provider public key**,
   - feeds the decisions into the **on-chain Mafia state machine** (apply night kills,
     tally day votes, eliminate, check parity each round),
   - derives the **winning faction** and settles the market, paying the winning side.
3. A forged, missing, or out-of-order decision ⇒ signature check or state-machine
   validation fails ⇒ **settlement reverts**; nobody is paid on a rigged game.

Gas: an MVP match is ~20–40 structured decisions ⇒ ~40 `ecrecover` calls (cheap) plus a
small state machine. Tractable on testnet in a single settle tx.

**Scope fallback (must be labeled if used):** if the full on-chain state machine + sig
verification cannot land by Jun 23, fall back to **server-submitted, TEE-gated** settle —
contract verifies the TEE signatures + commit-reveal on-chain but trusts the server's
tally — **explicitly marked `// MOCK:` / downgraded**, with full on-chain verification as
the target. The TEE signatures and commit-reveal stay real either way.

## 7. Commit-reveal: role assignment

The privileged secret is **who is Mafia** — public knowledge would skew faction-win bets,
and a server that assigned roles after seeing the betting flow could manipulate outcomes.

- **Commit:** before betting opens, the moderator assigns roles from a secret seed; the
  server submits `hash(role assignment + salt)` to the contract.
- **Bet:** the community bets without knowing roles.
- **Reveal:** at settlement, the server reveals `roles + salt`; the contract verifies it
  matches the commit before using the roles in the state machine.

This binds the server to a role assignment fixed **before** betting.

## 8. Components

| Package | Role | Change from current scaffold |
|---|---|---|
| `engine/` | **Deterministic moderator**: role assignment from seed, night/day phase sequencing, legal-move validation, vote tally, death resolution, win detection. Pure, no LLM, no I/O. Rules mirrored in Solidity. | Repurposed from "chess engine". |
| `players/` | **Player abstraction**: build prompt (role + persona + visible state), call 0G Compute TEE inference, parse output into `{speech, structuredDecision, attestation}`. Same model now; one interface so each seat can be a distinct model/provider later (**BYOM-ready**). | New (replaces "agents"). |
| `server/` | **Sequencer**: drive moderator loop, call players, stream to UI over WebSocket (~1 turn/sec), orchestrate 0G Storage uploads + contract calls (commit, settle). | Expanded. |
| `contracts/` | Escrow + on-chain TEE-sig verifier + Mafia state machine + commit-reveal. Binary faction market, extensible to multiple markets. | Repurposed. |
| `storage/` | 0G Storage integration: lock prompts pre-match; store transcript + signatures post-match; round-trip hash check. | Mostly unchanged. |
| `oracle/` | **Deleted.** Settlement is on-chain; no Compute oracle. Reusable test helpers fold into `contracts`. | Removed. |
| `frontend/` | Live arena (player avatars, day/night phases, speech feed, deaths), betting panel, trust badges (commit pre-bet, roles revealed post-game, "TEE-attested by 0G Compute" per move). | Expanded. |

### Unit boundaries
- **Moderator** (`engine/`): input = `(seed, players, sequence of structured decisions)`;
  output = `(per-round state, winner)`. Testable in isolation, no network. Its rules are
  the single source of truth mirrored by the Solidity state machine.
- **Player** (`players/`): input = `(role, persona, visible state)`; output =
  `{speech, structuredDecision, attestation}`. The only unit that touches 0G Compute.
- **Contract** (`contracts/`): input = `(commit, bets, revealed roles+salt, decisions,
  signatures)`; output = settlement. Verifiable with local-chain tests independent of the
  live game.

## 9. End-to-end flow

1. Moderator assigns roles from a secret seed → server commits `hash(roles+salt)` on 0G
   Chain; player prompts locked on 0G Storage. **Betting opens.**
2. Bettors buy YES/NO (Mafia vs Town).
3. **Betting locks.** Match runs: each turn, server calls 0G Compute TEE inference →
   `{speech, decision, sig}` → streams to UI; moderator advances state.
4. Game ends; moderator has the winner. Full transcript + all signatures → 0G Storage.
5. **Settle:** server submits structured decisions + TEE signatures + revealed roles/salt.
   Contract verifies signatures, checks the reveal vs commit, runs the Mafia state machine,
   computes the winner, pays the winning side. Forged/missing signature ⇒ revert.

## 10. Open verification items (→ `myTasks.md`)

1. **0G TEE attestation format** — confirm: (a) signature scheme is secp256k1/ECDSA so
   Solidity `ecrecover` works; (b) exactly *what bytes* are signed (structured-decision
   payload vs. full request/response envelope); (c) how the provider public key is
   published/registered for on-chain lookup. **The entire on-chain-verification design
   depends on this.**
2. **0G Compute access** — provider/model availability, router vs direct path, API key /
   wallet for inference calls.
3. **0G Storage credentials** + **0G Chain testnet wallet/faucet/RPC** (carried over from
   the original `myTasks.md`).

## 11. What is real vs. mocked (MVP honesty)

- **Real:** 0G Compute TEE inference, 0G Storage upload/retrieve, 0G Chain escrow +
  commit-reveal + TEE-signature verification.
- **Possibly downgraded (must be labeled):** the full on-chain Mafia state machine — see
  the §6 fallback. Any downgrade marked `// MOCK:` and surfaced in `STATUS.md`.
- **No silent mocks** of any 0G layer.
