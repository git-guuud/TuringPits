# Day 5 — Betting Contract + On-Chain TEE Verifier (`MafiaMarket.sol`)

**Date:** 2026-06-17 (Day 5 in the Jun 17→23 plan)
**Scope:** One bounded task — the on-chain ledger AND trustless settlement for a single
AI-Mafia match. Deploys to 0G Galileo testnet.
**References:** `TODO.md` Day 5, `IDEA.md` §2/§4, the AI-Mafia design spec
(`2026-06-17-ai-mafia-design.md`) §6/§7, and `STATUS.md` "0G integration — confirmed facts".

## 1. Goal & exit criteria

A `MafiaMarket` contract, deployed to 0G Chain testnet, that:
- holds a binary YES/NO faction-win market (parimutuel),
- binds the host to a pre-betting role commit (commit-reveal),
- at settlement verifies **each move's real 0G-TEE attestation on-chain** (envelope
  reconstruction + `ecrecover`),
- runs the **Mafia rules in Solidity** to compute the winning faction from the verified
  moves, and pays the winning side.

**Exit (from `TODO.md`):** deployed to testnet; a wallet bets, betting locks, an honest
match settles with the *on-chain-computed* winner, the winning side claims; a
forged/missing decision signature makes `settle()` revert. Tests cover the happy path, the
cheat path, and reject double-claim / settle-before-lock / bad role reveal.

## 2. Key design decisions (resolved in brainstorming)

1. **Signature scheme = full real-TEE envelope.** The contract verifies the *actual* bytes
   0G Compute signs, not the bare decision string. Per the live-confirmed format
   (`STATUS.md`), the signed text is the envelope
   `sha256(req):sha256(res):provider_type:provider_identity:tls_fingerprint`, EIP-191-signed,
   where `part[1] = sha256(raw response body)` and the decision is `choices[0].message.content`
   inside that JSON body.
2. **Decision↔body binding = offset/slice, not on-chain JSON parsing.** The submitter
   provides `(contentOffset, contentLen)`; the contract checks
   `rawBody[offset : offset+len] == jsonEscape(encodeDecision(d))`. Sound under the threat
   model — the signature fixes the whole body, so a wrong offset cannot yield a *different
   valid* decision — and far cheaper/less brittle than a Solidity JSON parser.
3. **Roles are revealed, not re-derived.** `settle` takes `(revealedRoles, salt)`; the
   contract checks the commit and runs the state machine over those roles. No on-chain PRNG
   / Fisher–Yates.
4. **Parimutuel accounting.** Winners split the whole pot pro-rata to their winning-side
   stake.

## 3. Lifecycle & storage

States: `Open → Locked → Settled`. Host = the constructor caller (deployer); stored as
`host` and required by `openMarket`/`lockBetting`/`settle`.

Stored:
- `bytes32 roleCommit` — `sha256(abi.encodePacked(uint8[] roles, bytes32 salt))`.
- `address teeSigner` — the registered provider TEE signer (`teeSignerAddress`, e.g.
  `0x83df…08cF`); the key every move's signature must recover to.
- `ProviderMeta { string providerType; string providerIdentity; string tlsFingerprint; }`
  — match-level envelope parts (constant across the match).
- `string nonce` — the match nonce shared by all decisions (a string, matching
  `encodeDecision`'s `JSON.stringify(nonce)`; `jsonEscape` covers it on-chain).
- `uint8 playerCount`.
- Pools: `uint256 yesPool, noPool`; `mapping(address => uint256) yesStake, noStake`.
- `Side winningSide`, `bool settled`; `mapping(address => bool) claimed`.

Functions:
- `openMarket(bytes32 roleCommit, address teeSigner, ProviderMeta meta, bytes32 nonce, uint8 playerCount)`
  → state `Open`.
- `placeBet(Side side) payable` → requires `Open`, `msg.value > 0`; adds to pool + stake.
- `lockBetting()` → host, `Open` → `Locked`.
- `settle(Move[] moves, Role[] revealedRoles, bytes32 salt)` → section 4/5/6.
- `claim()` → requires `Settled`; pays `pot * winnerStake / winningPool`; sets `claimed`.

`Side { No, Yes }`. `Yes` = "Mafia wins". `Role { MAFIA, DOCTOR, DETECTIVE, TOWN }`
(enum order MUST match `engine/src/commit.ts` `ROLE_ENUM`).

## 4. Commit-reveal verification

```
preimage = abi.encodePacked(uint8[] revealedRoles, salt)   // role enums in seat order ++ 32-byte salt
require(sha256(preimage) == roleCommit)                     // SHA-256 precompile 0x2
require(revealedRoles.length == playerCount)
```

Byte-identical to `roleCommitPreimage` / `commitRoles` in `engine/src/commit.ts`.

## 5. Per-move envelope verification

Each `Move` carries: `bytes rawResponseBody`, `uint256 contentOffset`, `uint256 contentLen`,
`string reqHashHex` (envelope `part[0]`, opaque), `bytes signature`, and the typed decision
`{ Phase phase, uint round, uint player, Action action, uint target }` (`nonce` is shared).

Per move:
1. `resHashHex = toHex(sha256(rawResponseBody))` via precompile 0x2.
2. `envelope = string.concat(reqHashHex, ":", resHashHex, ":", meta.providerType, ":",
   meta.providerIdentity, ":", meta.tlsFingerprint)`.
3. `digest = keccak256("\x19Ethereum Signed Message:\n" + decimalLen(envelope) + envelope)`;
   `require(ecrecover(digest, v, r, s) == teeSigner)`.
4. `expected = jsonEscape(encodeDecision(d))`; `require(slice(rawResponseBody, contentOffset,
   contentLen) == expected)`.

`encodeDecision` is reconstructed in Solidity as string concatenation, mirroring
`engine/src/encoding.ts` byte-for-byte (fixed key order, no whitespace; `phase`/`action` are
fixed enum→string maps; `round`/`player`/`target` are uint decimals; `nonce` is the match
nonce). `jsonEscape` escapes the `"` characters (the only special chars present) to `\"`.

Any failed hash/recover/slice ⇒ `settle()` reverts (the cheat path).

## 6. On-chain Mafia state machine

A Solidity port of `engine/src/moderator.ts`, fed the verified typed decisions **in submission
order** over the revealed roles:
- `assertLegal` per decision: game-not-over, `nonce` match, `phase`/`round` match current,
  indices in range, actor & target alive, action legal for phase, night action matches role
  (`kill→MAFIA`, `save→DOCTOR`, `investigate→DETECTIVE`), no double-act in a phase. Violation
  ⇒ revert.
- Accumulate `pending`; when every expected actor for the phase has acted, resolve:
  - **night:** plurality `kill` target; if `== save` target it's negated; else that seat dies.
    Investigations are win-neutral (skipped on-chain). Advance to `day`.
  - **day:** plurality `vote` elimination (tie → no-op). Advance to next `night`.
- `computeWinner`: `aliveMafia == 0 → TOWN`; `aliveMafia >= aliveTown → MAFIA`; else ongoing.
- After processing all moves, `winner` MUST be non-null (`MAFIA`→`Yes`, `TOWN`→`No`); else
  revert (an incomplete decision set cannot settle).

Plurality, parity, and resolution must match the engine exactly so the on-chain winner equals
the engine winner for the same inputs.

## 7. Testing (Hardhat, local chain)

Fixtures build **real-shaped** envelopes (the verification mechanism is real; only the signer
is a labeled local key — same honest pattern as Days 2/4):
- generate an honest match's ordered decisions from the deterministic engine,
- for each, build a synthetic OpenAI-JSON body embedding `encodeDecision(d)` as
  `choices[0].message.content`, compute the real `sha256`, assemble the envelope, and EIP-191
  sign it with a **local test wallet registered as `teeSigner`**,
- record the content byte-range.

Cases: happy path (open→bet YES/NO→lock→settle→on-chain winner matches engine→claim pays
pro-rata); forged signature reverts; missing/dropped move reverts (incomplete game); tampered
decision (slice mismatch) reverts; bad role reveal reverts; settle-before-lock reverts;
double-claim reverts; bet-after-lock reverts.

## 8. Deploy

`scripts/deploy.ts` deploys `MafiaMarket` to 0G Galileo (chainId 16602, RPC
`https://evmrpc-testnet.0g.ai`, `DEPLOYER_PRIVATE_KEY` = Compute wallet). Record the address
in `STATUS.md`. Requires faucet funds (`myTasks.md §D`).

## 9. Scope boundaries & honesty

- `players/` is **untouched** this session. Reshaping its `Attestation` to carry the envelope
  (`rawResponseBody` + parts) for the Day 6/7 live e2e is a documented follow-up; the contract
  is tested in isolation per the design's unit boundary.
- The test signer is a **labeled local key**, never presented as a real attestation. The
  envelope shape, hashing, and `ecrecover` are exactly what a live 0G-TEE signature requires.
- **Labeled fallback (only if the state machine can't land by Jun 23):** verify signatures +
  commit-reveal on-chain but accept a server-submitted tally, marked `// MOCK:` / downgraded,
  with full verification as the target. The TEE signatures and commit-reveal stay real either
  way.
