# @turingpits/engine

The deterministic **Mafia moderator** — the rule spine the whole protocol verifies
against. Pure functions: no LLM, no clock, no `Math.random`, no I/O. Its rules are the
single source of truth the Solidity state machine (Day 5) mirrors.

Design: `docs/superpowers/specs/2026-06-17-moderator-engine-design.md`.

## Hard rules
- No wall-clock, no `Date`, no `Math.random`, no network. Ever.
- The only randomness is the seed, via a deterministic SHA-256 counter-stream PRNG.
- Identical `(seed, n, nonce, decisions)` ⇒ identical per-round state and winner.

## Roles & factions
`MAFIA | DOCTOR | DETECTIVE | TOWN`. Win-faction is binary: **MAFIA** vs everyone else
(TOWN-aligned). Composition by seat count (MVP 5–7): n=5 → 1/1/1/2, n=6 → 1/1/1/3,
n=7 → 2/1/1/3 (MAFIA/DOCTOR/DETECTIVE/TOWN).

## API
```ts
assignRoles(seed, n): Role[]                       // seeded Fisher–Yates
initState(seed, n, nonce): GameState               // night-1, all alive
applyDecision(state, decision): GameState          // validates; throws on illegal/out-of-order
winner(state): "MAFIA" | "TOWN" | null
encodeDecision(decision): string                   // canonical signed bytes (the TEE signs this)
runMatch(seed, n, nonce, decisions): { states, winner }  // folds; snapshots each resolution
```

## The structured decision (signed unit)
`{ nonce, phase, round, player, action, target }` — canonical JSON, fixed key order, no
whitespace. `round` blocks intra-match replay; `nonce` blocks cross-match replay. The Day-5
contract reconstructs this exact string from typed calldata and `ecrecover`s it.

## Phases
NIGHT round 1 → DAY round 1 → NIGHT round 2 → … Night: mafia `kill` (plurality, tie → no
kill), doctor `save` (cancels a matching kill), detective `investigate` (recorded, no
mechanical effect). Day: every living player `vote`s; plurality eliminated, tie → no one.
Win is checked after every resolution: TOWN when no mafia remain, MAFIA at parity.

## Tests
`npm test` (vitest): determinism, scripted MAFIA/TOWN matches with per-round snapshots,
doctor-save, detective-record, tie handling, role/seed composition, and every illegal-move
class (bad nonce, wrong phase/round, dead actor/target, role-not-permitted,
action-wrong-for-phase, duplicate, decision-after-game-over).
