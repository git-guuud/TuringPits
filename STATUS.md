# Status

_Updated: 2026-06-17_

## Current task
Pivoted to **AI Mafia** (multiple LLMs playing Mafia). Day 1 — moderator engine +
structured decisions (see `TODO.md`). Design: `docs/superpowers/specs/2026-06-17-ai-mafia-design.md`.

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

## In progress
- [ ] Day 2 — `players/` abstraction over 0G Compute TEE inference (next session).

## Pending
- Days 2–7 per `TODO.md`. `players/` package not yet created.

## Mocks / stubs in place
- `engine/` is real (no mocks). `storage` still throws-stub; `server`/`frontend` no-op
  stubs; `contracts` not yet rewritten for Mafia. None of the 0G layers are wired.
- No data is mocked. No silent mocks anywhere.

## Known scope risk
- Day 5's **on-chain Mafia state machine + TEE-signature verification** is the heaviest
  piece. Labeled fallback (verify sigs + commit-reveal on-chain, trust the tally) is queued
  in `TODO.md` if it can't fully land by Jun 23.
- Gated on confirming the **0G TEE attestation format** (`myTasks.md` §A).
