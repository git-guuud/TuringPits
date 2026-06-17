# Status

_Updated: 2026-06-17_

## Current task
**AI Mafia** (multiple LLMs playing Mafia). Day 2 — `players/` abstraction over 0G Compute
TEE inference — **complete** (see `TODO.md`). Next: Day 3 (commit-reveal + confirm the live
TEE attestation format). Design: `docs/superpowers/specs/2026-06-17-ai-mafia-design.md`.

## Done
- [x] Monorepo scaffolded (npm workspaces): `engine`, `contracts`, `storage`,
      `server`, `frontend` — each with package manifest, tsconfig, stub source, README.
      (`oracle` removed — settlement is on-chain.)
- [x] **Day 1 — Moderator engine + structured decisions.** `engine/` is the deterministic
      Mafia moderator: `assignRoles` (seeded Fisher–Yates), `initState`, `applyDecision`
      (validates + throws on illegal/out-of-order), `winner`, `runMatch`, and
      `encodeDecision` (canonical-JSON signed bytes). Roles MAFIA/DOCTOR/DETECTIVE/TOWN,
      night/day sequencing, doctor save, detective record, plurality tallies (tie → no-op),
      parity/elimination win detection. Pure, zero non-deterministic inputs. 22 vitest
      tests green (determinism, scripted MAFIA/TOWN matches, all illegal-move classes).
      Design: `docs/superpowers/specs/2026-06-17-moderator-engine-design.md`.
- [x] Root tooling: `package.json` workspaces, `tsconfig.base.json`, `.gitignore`,
      `README.md`.
- [x] **Verified 0G capabilities** against the docs: Compute is AI-inference/fine-tuning
      only (cannot run arbitrary code) → original "Compute re-runs the match" path dropped.
- [x] **Game decided: LLM Mafia.** Trust anchor = TEE-attested inference; settlement =
      fully on-chain (verify TEE sigs + Mafia rules in Solidity). Faction-win market for MVP.
- [x] Design spec written and approved.

- [x] **Day 2 — `players/` abstraction over 0G Compute TEE inference.** New `players/`
      workspace. One `InferenceProvider` interface (BYOM-ready: each seat holds its own
      provider). `Player.takeTurn` produces the two-layer turn — free-form `speech` + a
      constrained decision inference whose *entire* output IS the canonical decision string
      (`encodeDecision`), so the attestation binds the exact bytes the contract reconstructs
      (`myTasks.md §A`). `verifyAttestation` is the real, reusable EIP-191 `ecrecover` check
      the Day-5 contract mirrors. `playMatch` drives the Day-1 moderator with real player
      calls and captures the attested transcript. 25 vitest tests green: a full match runs
      end-to-end, every decision attestation verifies locally, the captured decisions replay
      through the pure moderator to the same winner, and parse rejects illegal/non-canonical
      output. Real `ZeroGComputeProvider` (Router + `verify_tee`) is written but **unexercised
      pending §B creds** — see Mocks below.

## In progress
- [ ] Day 3 — commit-reveal for role assignment + confirm the live TEE attestation format
      against `myTasks.md §A` (next session).

## Pending
- Days 3–7 per `TODO.md`.

## Mocks / stubs in place
- `engine/` and the `players/` abstraction are real (no mocks). `storage` still throws-stub;
  `server`/`frontend` no-op stubs; `contracts` not yet rewritten for Mafia.
- **`players/` inference — MOCKED, flagged (`# MOCK:` in `provider.ts`).** Live 0G Compute
  access is unavailable (`myTasks.md §B` not provisioned: no API key, no model chosen), so
  the e2e match runs on `MockLocalProvider`: a **local** ECDSA/EIP-191 signer. Signatures are
  **real** (the verification path is genuinely exercised) but the signer is a **local test
  key, NOT a 0G TEE provider** — `source` is always `"MOCK-local"`, never mistaken for a real
  attestation. No attestation is faked silently.
- **`ZeroGComputeProvider` (real Router path) — partially live-confirmed (2026-06-17).**
  Real calls (`players/scripts/live-turn.mjs`) confirm: inference works, `qwen2.5-omni` is
  genuinely TEE-attested (`tee_verified:true`, provider `0xa48f…7836`), chatID = `zg-res-key`
  header, and the live model emits canonical decision strings `parseDecision` accepts.
  The router gives `tee_verified` but NOT the raw signature; the **Direct SDK** does.
- **Raw TEE signature path — CONFIRMED live (2026-06-17, `players/scripts/live-direct.mjs`).**
  Via `@0gfoundation/0g-compute-ts-sdk`: signature `ecrecover`s (EIP-191/ECDSA) to the
  on-chain `teeSignerAddress` `0x83df…08cF` ⇒ **on-chain verification is viable.** Signed bytes
  are an envelope `sha256(request):sha256(response):provider_type:provider_identity:tls_fingerprint`
  (resHash = `sha256(response body)` confirmed) — NOT the raw text, so the Day-5 verifier
  reconstructs the envelope (SHA-256 precompile + ecrecover); see `myTasks.md §A` "LIVE
  DIRECT-SDK SIGNATURE". ⚠️ Trust caveat: provider metadata is `centralized:aliyun` (RA-TLS),
  not visibly hardware-TEE — mechanism real, execution-guarantee weaker than "hardware TEE."
  The match e2e test still runs on `MockLocalProvider`; wiring the Direct provider into
  `playMatch` is Day-3/5 work.

## Known scope risk
- Day 5's **on-chain Mafia state machine + TEE-signature verification** is the heaviest
  piece. Labeled fallback (verify sigs + commit-reveal on-chain, trust the tally) is queued
  in `TODO.md` if it can't fully land by Jun 23.
- Gated on confirming the **0G TEE attestation format** (`myTasks.md` §A).
