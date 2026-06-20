# Handover — Parimutuel Market Logic (`MafiaMarket` factory rewrite)

**Branch:** `dev-parth` (== `main` at this commit) · **Date:** 2026-06-19
**Scope of this handover:** the on-chain **market/betting logic only** (contracts + tests).
Server/frontend/engine/players/storage are unchanged by this work.

---

> **Addendum — 2026-06-19 security hardening** (commit `8aa6f9b`, post-merge re-audit). Four
> changes to `MafiaMarket.sol`, all covered by a new `test/MafiaMarket.hardening.test.ts` (10
> tests; suite now **47 passing**):
> 1. **`settle` is `onlyOwner`.** Permissionless settle let a losing bettor copy the revealed
>    salt from the mempool and submit a *truncated* move list to force a Draw. Only the host
>    holds the reveal, so this lost no liveness; `enterRefundMode`/`refund` stays the
>    host-failure fallback.
> 2. **Role composition enforced on reveal** (engine COMPOSITION for 5/6/7 players) so a host
>    cannot relabel TOWN seats as MAFIA to flip the winner.
> 3. **`createMatch` input validation:** rejects a zero `roleCommit` and a non-printable/empty
>    `nonce` (would otherwise silently brick settlement).
> 4. **`transferOwnership`** added for host key rotation.
>
> The contract NatSpec now reads **trust-minimized**, not "trustless": settlement still assumes
> `teeSigner` is the genuine 0G-TEE key (the host sets it per match). The authoritative spec
> (`docs/superpowers/specs/2026-06-18-parimutuel-market-factory-design.md`) carries the same
> addendum.

---

## 1. TL;DR

`contracts/contracts/MafiaMarket.sol` was rewritten from a one-match-per-deploy escrow into
a **multi-match parimutuel faction-win market factory**: one deployed contract holds many
matches keyed by `matchId`, with a block-based lifecycle, per-match fees, four settlement
outcomes (Yes / No / **Draw** / **Void**), and a settlement-timeout **refund mode**. The
proven on-chain settlement (0G-TEE envelope `ecrecover` + commit-reveal + Solidity Mafia
rules) is reused **verbatim**.

This **closes both Day-5 limitations** recorded in `STATUS.md`:
1. **Trapped pot when the winning side had zero bets** → now resolves to **Void** = full
   refund of every bettor's own stake.
2. **No settlement timeout / no bettor reclaim** → now `enterRefundMode` + `refund` after
   `settlementDeadlineBlock`.

**Status:** complete, reviewed, merged to `main`, then **security-hardened (2026-06-19, see the
addendum above)**. **47 tests passing. Deployed 2026-06-19** to 0G Galileo testnet at
`0xC4AB34051aad9f58a960b24f26666987845AEd92` — see §6 / [`DEPLOYMENT.md`](DEPLOYMENT.md).

---

## 2. How to build & test

```bash
cd contracts
npm install          # if node_modules missing
npx hardhat test     # full suite — expect 47 passing
```

- Single file: `npx hardhat test test/MafiaMarket.test.ts`
- Fuzz only: `npx hardhat test test/MafiaMarket.fuzz.test.ts`
- A harmless `WARNING: Node.js v18 … not supported by Hardhat` prints on every run
  (pre-existing infra; tests pass regardless). Upgrading Node ≥20 silences it.
- **`viaIR: true`** is enabled in `hardhat.config.ts` (required because the 22-field `Match`
  struct's auto-generated public getter overflows the legacy compiler's stack). First compile
  after a clean checkout is a little slow because of this.

---

## 3. Contract API (`MafiaMarket.sol`)

`constructor(address _treasury)` — deployer becomes `owner` (the trusted host); `_treasury`
receives protocol fees.

| Function | Auth | Purpose |
|---|---|---|
| `createMatch(CreateMatchParams)` → `matchId` | `onlyOwner` | Open a new match; validates the block schedule + fee caps + nonzero `roleCommit` + printable-ASCII `nonce`; generates `entropySeed`. No payment. |
| `betYes(matchId)` / `betNo(matchId)` | anyone, `payable` | Bet within the open window; `MIN_BET ≤ value ≤ MAX_BET_PER_TX`. |
| `lockBetting(matchId)` | anyone | Optional convenience: `Created→Locked` once `block ≥ bettingCloseBlock` (just emits; settle works without it). |
| `settle(matchId, moves, revealedRoles, salt, transcriptCID)` | `onlyOwner` (host) | Verifies every move's TEE envelope + commit-reveal + **role composition**, runs the rules engine, resolves the outcome, caches `netPot`. Owner-only to close a reveal front-run (see addendum). |
| `claim(matchId)` | anyone | Pull-pattern payout for a settled match. |
| `enterRefundMode(matchId)` | anyone | `Created/Locked → RefundMode` once `block > settlementDeadlineBlock`. |
| `refund(matchId)` | anyone | Full own-stake reclaim in refund mode. |
| `withdrawProtocolFees()` | `onlyTreasury` | Sweep accrued fees (never blocks user claims). |
| `transferOwnership(newOwner)` | `onlyOwner` | Rotate the trusted-host role; emits `OwnershipTransferred`. |

**States:** `None, Created, Locked, Settled, RefundMode` (`None == 0` so a nonexistent
`matchId` safely reverts everywhere). **Outcomes:** `Unset, Yes, No, Draw, Void`.

**Payout math** (`gross = poolYes + poolNo`):
- **Yes/No** (winning pool > 0): `fee = gross·feeBps/1e4`; winner gets `netPot·stake/winningPool` (floor; wei dust stays in contract — intentional, spec §7).
- **Draw** (legal transcript that never reached a faction-win, e.g. a truncated game): each bettor gets `ownStake·(1e4−feeBpsDraw)/1e4`.
- **Void** (a faction won but its pool was empty): full own-stake refund, **no fee**.
- **RefundMode** (deadline passed, never settled): full own-stake refund, no fee.

**Events** (for the frontend indexer): `MatchCreated, BetPlaced, BettingLocked,
MatchSettled, Claimed, RefundModeEntered, Refunded`.

**Constants:** `MIN_BET = 0.01 ether`, `MAX_BET_PER_TX = 10_000 ether`,
`MIN_BETTING_WINDOW = 100`, `LOCK_BUFFER = 5`, `MIN_MATCH_DURATION = 25`,
`MAX_FEE_BPS = 500`. Default demo fees in tests: `feeBps = 200` (2%), `feeBpsDraw = 50` (0.5%).

---

## 4. What's real vs. mocked (per CLAUDE.md)

- **Real:** the entire market accounting, lifecycle state machine, and the settlement
  verification *mechanism* — the contract reconstructs the actual 0G-TEE response envelope,
  `ecrecover`s the signer, binds the typed decision to the signed body, checks the
  commit-reveal, and runs a faithful Solidity port of the engine's Mafia rules.
- **Labeled test substitute (not a silent mock):** in tests, the `teeSigner` is a local
  ECDSA key (`buildEnvelope`/`buildSettlement` in `test/helpers/`). The signatures are
  genuinely produced and verified — only the *signer identity* is local instead of the live
  0G provider key `0x83df…08cF`. The verification path is identical to production.

---

## 5. Deliberate deferrals (documented in the design spec §7 — NOT accidental gaps)

- `entropySeed` is generated + emitted but **not enforced** in `settle` (anti-grinding
  enforcement needs a coordinated engine change; the real anchor is that roles are committed
  before betting opens).
- `personaPoolRoot` is stored + emitted but **not** allowlist/leaf-enforced.
- **No** host seed / host bond (pure bettor parimutuel — product decision).
- **No** settler bounty, **no** dust-sweep timer, **no** VRF (this system's trust anchor is
  TEE + commit-reveal).
- Integer-division dust on Yes/No claims (wei-scale) stays in the contract by design.

> ⚠️ `PredictionMarket.md` at the repo root is the **older** design (host seed/bond, extra
> states, settler bounty) and is now **superseded** — it has a banner pointing to the
> authoritative spec. Do **not** implement against `PredictionMarket.md`.

---

## 6. Deployment status

- **DEPLOYED 2026-06-19** to 0G Galileo testnet at
  **`0xC4AB34051aad9f58a960b24f26666987845AEd92`** (owner/treasury
  `0xCDa8102a5eD9cbF154295D2ef62ea4AFFF47F134`; source commit `869296b`). Full record in
  [`DEPLOYMENT.md`](DEPLOYMENT.md). The old single-match address
  `0xd4d1007585f9bAa44DaBbBCb224a09395F41ca5F` is **STALE — superseded by the above**.
- Deploy: `cd contracts && npm run deploy:0g`
  - Network: 0G Galileo testnet (chainId 16602, RPC `https://evmrpc-testnet.0g.ai`).
  - Env: `DEPLOYER_PRIVATE_KEY` (required), `PROTOCOL_TREASURY` (optional — defaults to the
    deployer). See `.env.example` / `myTasks.md`.
  - The new constructor takes `_treasury`; `scripts/deploy.ts` already passes it.

---

## 7. Next steps (Day 6 / Day 7 — out of scope for this branch)

1. **Re-deploy** the factory to Galileo; record the new address in `STATUS.md`.
2. **Rewire `server/` + `frontend/`** to the factory ABI: everything is now `matchId`-keyed,
   `createMatch` takes a `CreateMatchParams` struct, and `settle` takes
   `(matchId, moves, revealedRoles, salt, transcriptCID)`. Index the new events for live odds.
3. **End-to-end run:** open a match → bets → lock → real `qwen2.5-omni` TEE match → upload
   transcript to 0G Storage → `settle` on-chain → claim — all from the UI (TODO.md Day 6/7).
4. Optional hardening if it ever matters: enforce `entropySeed`/`personaPoolRoot`; add a
   settler bounty.

---

## 8. Key files

| File | What |
|---|---|
| `contracts/contracts/MafiaMarket.sol` | The market factory (this work). |
| `contracts/contracts/lib/{DecisionCodec,TeeEnvelope,MafiaRules}.sol` | Unchanged verification libs (only a verified `memory-safe` annotation was added to `TeeEnvelope` for `viaIR`). |
| `contracts/contracts/MafiaTypes.sol` | `Role/Phase/Action/Side` enums + `Decision` struct (unchanged). |
| `contracts/test/MafiaMarket.test.ts` | 28 lifecycle/accounting/outcome/cross-match tests. |
| `contracts/test/MafiaMarket.fuzz.test.ts` | Deterministic conservation property (8 iterations). |
| `contracts/test/PlayersIntegration.test.ts` | Cross-layer: a real transcript settles on-chain to the engine-declared winner. |
| `contracts/scripts/deploy.ts` | Factory deploy (passes treasury). |
| `docs/superpowers/specs/2026-06-18-parimutuel-market-factory-design.md` | **Authoritative design spec.** |
| `docs/superpowers/plans/2026-06-18-parimutuel-market-factory.md` | The TDD implementation plan that was executed. |
| `STATUS.md` | Updated: both Day-5 gaps closed; factory model recorded. |

---

## 9. Verification evidence

- Full suite: **47 passing** (`cd contracts && npx hardhat test`).
- Built TDD: every function landed test-first; 7 tasks, each peer-reviewed.
- Final whole-branch review: **no Critical findings**; per-match solvency, CEI/reentrancy on
  all three payout sites, the four-outcome state machine, and the Void zero-divisor guard all
  verified. The one theoretical edge (total stake > `uint128`, ≈3.4e20 ether) is documented
  in-code and is recoverable via refund mode — never trapped.

## 10. Git state

- `main` and `dev-parth` both at the merged tip; the feature branch
  `feat/parimutuel-market-factory` was fast-forward-merged and deleted.
- **Local only — not pushed to `origin`.** `main` is ~10 commits ahead of `origin/main`.
- `package-lock.json` is modified in the working tree (an `npm install` side-effect); not
  committed — decide whether to keep or revert.
