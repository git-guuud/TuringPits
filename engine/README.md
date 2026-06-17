# @turingpits/engine

The deterministic chess match engine — the spine the whole protocol verifies against.

`playMatch({ seed, white, black })` runs a full game and returns canonical **PGN**
(the battle log), the result, and the move list. It MUST be a pure function: identical
input yields byte-identical output, and the seed is the *only* source of randomness.

## Hard rules
- No wall-clock, no `Date`, no `Math.random`, no I/O, no network. Ever.
- All randomness flows through the seeded PRNG passed to agents.
- Output PGN must be canonical (stable headers, move formatting) so its hash is stable.

## Agents
An `Agent` implements `selectMove(fen, legal, rng)` and returns a SAN move from
`legal`. Two deterministic baseline agents ship for the MVP demo.

## Next (TODO.md Day 1/2)
Implement `playMatch` + the two baseline agents; enable the determinism test.
Then add the PGN serializer and the replay verifier (Day 2).
