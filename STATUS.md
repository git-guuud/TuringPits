# Status

_Updated: 2026-06-17_

## Current task
Pivoted to **AI Mafia** (multiple LLMs playing Mafia). Day 1 — moderator engine +
structured decisions (see `TODO.md`). Design: `docs/superpowers/specs/2026-06-17-ai-mafia-design.md`.

## Done
- [x] Monorepo scaffolded (npm workspaces): `engine`, `contracts`, `storage`,
      `oracle`, `server`, `frontend` — each with package manifest, tsconfig,
      stub source, and README.
- [x] Root tooling: `package.json` workspaces, `tsconfig.base.json`, `.gitignore`,
      `README.md`.
- [x] **Verified 0G capabilities** against the docs: Compute is AI-inference/fine-tuning
      only (cannot run arbitrary code) → original "Compute re-runs the match" path dropped.
- [x] **Game decided: LLM Mafia.** Trust anchor = TEE-attested inference; settlement =
      fully on-chain (verify TEE sigs + Mafia rules in Solidity). Faction-win market for MVP.
- [x] Design spec written and approved.

## In progress
- [ ] Revise scaffold to the Mafia design: repurpose `engine/` as the deterministic
      moderator, add `players/`, remove `oracle/` (settlement is on-chain).
- [ ] Implement the moderator + structured-decision format (Day 1).

## Pending
- Days 2–7 per `TODO.md`.

## Mocks / stubs in place
- All package entrypoints are still the original stubs that **throw** (engine, storage,
  oracle) or no-op (server, frontend) — none rewritten for Mafia yet.
- No data is mocked. None of the 0G layers are wired.

## Known scope risk
- Day 5's **on-chain Mafia state machine + TEE-signature verification** is the heaviest
  piece. Labeled fallback (verify sigs + commit-reveal on-chain, trust the tally) is queued
  in `TODO.md` if it can't fully land by Jun 23.
- Gated on confirming the **0G TEE attestation format** (`myTasks.md` §A).
