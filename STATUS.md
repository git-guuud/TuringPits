# Status

_Updated: 2026-06-17_

## Current task
Day 1 — Scaffold + deterministic chess engine core (see `TODO.md`).

## Done
- [x] Monorepo scaffolded (npm workspaces): `engine`, `contracts`, `storage`,
      `oracle`, `server`, `frontend` — each with package manifest, tsconfig,
      stub source, and README.
- [x] Root tooling: `package.json` workspaces, `tsconfig.base.json`, `.gitignore`,
      `README.md`.
- [x] Game format decided: **full chess** (PGN battle log).
- [x] `myTasks.md` filed with 0G credentials/funds needed for Days 3–5.

## In progress
- [ ] Implement deterministic chess engine (`engine/`) + two baseline agents.
- [ ] Enable engine determinism test (currently `describe.skip`).

## Pending
- Days 2–7 per `TODO.md`.

## Mocks / stubs in place
- All package entrypoints are stubs that **throw** (engine, storage, oracle) or
  no-op (server, frontend) so nothing silently depends on a fake result.
- No data is mocked yet. None of the 0G layers are wired.
