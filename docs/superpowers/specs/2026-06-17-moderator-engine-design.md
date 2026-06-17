# Moderator Engine Design — `engine/` (Day 1)

_Date: 2026-06-17_
_Status: Approved design, pre-implementation_
_Parent: `2026-06-17-ai-mafia-design.md` §8 (`engine/`), §3 (structured decision)._

## Purpose

The deterministic Mafia **moderator**: the rule spine the whole protocol verifies
against. Pure functions, no LLM, no I/O, no clock, no `Math.random`. Given a fixed seed,
player count, match nonce, and an ordered sequence of structured decisions, it produces
the same per-round state and the same winner — and rejects illegal/out-of-order
decisions. Its rules are the single source of truth the Solidity state machine (Day 5)
mirrors.

This task also **removes the `oracle/` package** (settlement is on-chain; the stub has no
reusable code) and replaces the chess-era `engine` types/stub.

## Roles & factions

`Role = MAFIA | DOCTOR | DETECTIVE | TOWN`. Win-faction is binary: **MAFIA** vs everyone
else (TOWN-aligned = TOWN, DOCTOR, DETECTIVE).

Deterministic composition by player count (MVP supports 5–7):

| n | MAFIA | DOCTOR | DETECTIVE | TOWN |
|---|-------|--------|-----------|------|
| 5 | 1 | 1 | 1 | 2 |
| 6 | 1 | 1 | 1 | 3 |
| 7 | 2 | 1 | 1 | 3 |

Any other `n` is rejected.

## Role assignment

`assignRoles(seed, n)` builds the role multiset for `n`, then **Fisher–Yates** shuffles it
with a seeded PRNG: a counter-based SHA-256 stream, `sha256(seed ‖ counter)`, consumed as
big-endian integers. Pure and dependency-free via `node:crypto` (hashing is deterministic,
not I/O). Same `(seed, n)` → identical seat→role array every time.

The Day-3 commit-reveal commits this revealed array directly (`hash(roles+salt)==commit`),
so the shuffle never needs re-deriving on-chain — only off-chain determinism matters.

## Structured decision (the signed unit)

```ts
interface Decision {
  nonce: string;                                   // per-match; opaque to the moderator
  phase: "night" | "day";
  round: number;                                   // 1-based
  player: number;                                  // seat index
  action: "kill" | "save" | "investigate" | "vote";
  target: number;                                  // seat index
}
```

**Canonical encoding** = JSON, fixed key order, no whitespace:

```
{"nonce":"<n>","phase":"day","round":1,"player":2,"action":"vote","target":3}
```

`encodeDecision(d)` emits exactly these bytes — this is what the TEE signs.

- `round` binds a decision to its round (no intra-match replay across rounds).
- `nonce` binds it to a specific match (no replay across games).

**On-chain (Day 5) note:** the contract receives the decision fields as typed `uint8`/
nonce calldata and **reconstructs this canonical JSON string** (string-building, not JSON
parsing), hashes it, and `ecrecover`s. This honors the JSON-signed-bytes choice without
needing an on-chain JSON parser. Trade-off vs. ABI-encoding: ~a few hundred gas of string
assembly per decision; acceptable for ~20–40 decisions/match.

## Phase sequencing

Game starts at **NIGHT round 1** → DAY round 1 → NIGHT round 2 → DAY round 2 → … The win
condition is checked after **every** phase resolution; once a winner exists the game is
over and any further decision is rejected.

### Night resolution

A night phase is complete once **every living night-actor** has submitted exactly one
decision: every living MAFIA (`kill`), the DOCTOR if alive (`save`), the DETECTIVE if alive
(`investigate`). On completion:

1. **Mafia kill target** = plurality of mafia `kill` votes; a tie → **no kill**.
2. **Doctor save**: if the save target equals the kill target, the kill is prevented.
3. If a player is killed and not saved → they die.
4. **Detective**: the investigated target's faction is recorded in state (for the
   transcript/UI). No mechanical effect on deaths or the winner.

### Day resolution

A day phase is complete once **every living player** has submitted exactly one `vote`.
The plurality target is eliminated; a tie → **no elimination**. Plurality tallies are
order-independent, so resolution does not depend on submission order within the phase.

## Win conditions (checked after each resolution)

- **TOWN** wins when the living MAFIA count is 0.
- **MAFIA** wins when living MAFIA ≥ living TOWN-aligned (parity).

## API (all pure)

```ts
assignRoles(seed: string, n: number): Role[]
initState(seed: string, n: number, nonce: string): GameState
applyDecision(state: GameState, d: Decision): GameState   // validates; throws on illegal
winner(state: GameState): "MAFIA" | "TOWN" | null
encodeDecision(d: Decision): string                       // canonical signed bytes
runMatch(seed, n, nonce, decisions): { states: GameState[]; winner }  // folds; snapshots each resolution
```

`applyDecision` returns a new immutable state. `GameState` carries: per-seat
`{role, alive}`, current `phase`/`round`, accumulated pending actions for the open phase,
recorded detective investigations, and `winner` (null until decided). `runMatch` snapshots
state after each **phase resolution** (the "per-round state").

## Validation — `applyDecision` throws (rejected) on:

- `nonce` ≠ match nonce
- `phase`/`round` ≠ the state's current open phase/round (out-of-order)
- actor not alive, or `player`/`target` out of range, or target not alive
- role not permitted for the action (e.g. TOWN issuing `kill`, non-doctor `save`,
  non-detective `investigate`)
- action not valid for the phase (`vote` at night; `kill`/`save`/`investigate` by day)
- duplicate action by the same player in the same phase
- any decision after the game is already over

## Testing (vitest, run before done)

1. **Determinism**: `runMatch` twice on identical input → deep-equal states + winner.
2. **Scripted MAFIA-win** match: assert per-round snapshots + winner.
3. **Scripted TOWN-win** match: assert per-round snapshots + winner.
4. **Doctor save** prevents the mafia kill; **detective** result recorded.
5. **Tie vote** → no elimination.
6. `assignRoles`: correct composition counts per `n`, deterministic for a seed, rejects
   bad `n`.
7. Each **illegal-move class** throws: bad nonce, wrong phase, wrong round, dead actor,
   dead/out-of-range target, role-not-permitted, action-wrong-for-phase, duplicate action,
   decision-after-game-over.

## Exit criteria (TODO Day 1)

Given a fixed seed and a fixed sequence of structured decisions, the moderator produces the
same per-round state and the same winner (passing test). Illegal/out-of-order decisions are
rejected. Zero non-deterministic inputs. `oracle/` removed.
