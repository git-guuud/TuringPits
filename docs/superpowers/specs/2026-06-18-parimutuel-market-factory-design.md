# Parimutuel Faction-Win Market — Multi-Match Factory (`MafiaMarket.sol` rewrite)

**Date:** 2026-06-18
**Scope:** One bounded task — rewrite the betting/market *logic* (contracts only, no
frontend) from a single one-match-per-deploy escrow into a multi-match factory implementing
the full parimutuel market layer: block-based lifecycle, fees, draw/void/refund, and a
settlement timeout.
**References:** `PredictionMarket.md` (the market spec being implemented), `STATUS.md`
(Day-5 known limitations this closes), the Day-5 verifier design
(`2026-06-17-day5-onchain-verifier-design.md`), `IDEA.md` §2/§4.

> **Addendum — 2026-06-19 security hardening** (commit `8aa6f9b`). A post-merge re-audit
> hardened settlement; this spec is updated inline below to match the shipped contract:
> (1) `settle` is now **`onlyOwner`** — closes a reveal-front-run where a losing bettor could
> copy the revealed salt from the mempool and submit a *truncated* move list to force a Draw,
> denying the rightful winners (only the host holds the reveal, so permissionless settle added
> no liveness — refund mode remains the host-failure fallback);
> (2) **role composition is enforced** on reveal — the revealed multiset must equal the engine's
> COMPOSITION for the player count, so a host cannot relabel TOWN seats as MAFIA to flip the
> winner; (3) `createMatch` rejects a zero `roleCommit` and a non-printable/empty `nonce`;
> (4) added `transferOwnership` (host key rotation). "Trustless" is restated as
> **trust-minimized** — settlement still assumes `teeSigner` is the genuine 0G-TEE key. Suite:
> **47 passing**.

## 1. Goal

Replace `MafiaMarket.sol` with a factory contract that holds many parimutuel YES/NO
("Mafia wins" / "Town wins") faction-win markets keyed by `matchId`. Each match:

- runs a **block-based lifecycle** (betting opens/closes on block numbers; a settlement
  deadline triggers a trustless refund if the host never settles),
- accepts bets with a per-tx cap and a minimum,
- at settlement **reuses the existing, proven on-chain verification** (per-move 0G-TEE
  envelope `ecrecover` → decision-binding → commit-reveal → Solidity Mafia rules),
- pays the winning side pro-rata net of a protocol fee, and handles **DRAW**, **VOID**, and
  **REFUND** degenerate cases so no funds are ever trapped.

This closes the two Day-5 limitations flagged in `STATUS.md`: (1) a trapped losing pool when
the winning side received zero bets, and (2) no settlement timeout / bettor reclaim path.

## 2. Key decisions (resolved in brainstorming)

1. **Multi-match factory, single trusted host.** One deployed contract; `owner` (the demo
   host) calls `createMatch` per match. A permissionless multi-host registry is deferred
   (`PredictionMarket.md` §12.2).
2. **Block-based lifecycle.** `bettingOpenBlock`, `bettingCloseBlock`, `matchStartBlock`,
   `settlementDeadlineBlock` per match, with `MIN_BETTING_WINDOW` / `LOCK_BUFFER` /
   `MIN_MATCH_DURATION` guards. Enables permissionless lock and the timeout→refund safety net.
3. **No host seed, no host bond.** Pure bettor parimutuel. Pools start at 0; refund mode
   returns each bettor's own stake (no bond-share math — `PredictionMarket.md` §3.5's bond
   term drops out).
4. **Preserve the verification mechanics verbatim.** The three pure libraries
   (`DecisionCodec`, `TeeEnvelope`, `MafiaRules`) and `MafiaTypes.sol` are unchanged. Only the
   payout/lifecycle wrapper around `settle()` changes.
5. **No VRF.** This system's trust anchor is TEE + commit-reveal (`STATUS.md`); there is no
   VRF subsystem, so `PredictionMarket.md` §5.4's VRF/beaconValues checks are out of scope.

## 3. Storage

A single `Match` struct keyed by `matchId`, with the per-match TEE-binding fields (previously
contract-level singletons) moved inside it so one factory serves many matches.

```solidity
enum MatchState { None, Created, Locked, Settled, RefundMode }
enum Outcome    { Unset, Yes, No, Draw, Void }

struct Match {
    // lifecycle (packed: 1 enum + 4×uint64 fit one+ slot)
    MatchState state;
    uint64 bettingOpenBlock;
    uint64 bettingCloseBlock;
    uint64 matchStartBlock;
    uint64 settlementDeadlineBlock;

    // commit-reveal + TEE binding (per match)
    bytes32 roleCommit;
    bytes32 entropySeed;        // emitted at create; NOT enforced in settle (see §7)
    bytes32 personaPoolRoot;    // evidence pointer; NOT leaf-enforced (see §7)
    address teeSigner;
    string  providerType;
    string  providerIdentity;
    string  tlsFingerprint;
    string  nonce;
    uint8   playerCount;

    // pools (uint128 pack two-per-slot)
    uint128 poolYes;
    uint128 poolNo;

    // settlement result (cached for cheap claims)
    Outcome outcome;
    uint128 netPot;
    uint128 winningPool;
    bytes32 transcriptCID;      // 0G Storage evidence pointer

    // fees
    uint16 feeBps;
    uint16 feeBpsDraw;
}

mapping(uint256 => Match) public matches;                          // matchId => Match
mapping(uint256 => mapping(address => uint128)) public stakeYes;   // matchId => user => stake
mapping(uint256 => mapping(address => uint128)) public stakeNo;
mapping(uint256 => mapping(address => bool))    public claimed;

uint256 public nextMatchId;        // monotonic id allocator
uint128 public protocolFeeAccrued;
address public owner;              // the trusted host / match creator
address public protocolTreasury;   // fee recipient
```

**Dropped from `PredictionMarket.md` §4:** `hostSeedPerSide`, `hostBond` (no host stake);
the `CLAIMED`/`REFUNDED` aggregate match states (claims are per-user via the `claimed`
mapping — a whole-match "claimed" state is meaningless under the pull pattern).

**Parameters (constants):** `MIN_BET = 0.01e18`, `MAX_BET_PER_TX = 10_000e18`,
`MIN_BETTING_WINDOW = 100` blocks, `LOCK_BUFFER = 5`, `MIN_MATCH_DURATION = 25`,
`MAX_FEE_BPS = 500`. (Demo can pass small fee values; windows kept short-but-nonzero so a
live demo isn't gated on 100s of blocks — see Open Items.)

## 4. Lifecycle & functions

State `Open` is **derived**, not stored: a match is open for bets iff
`state == Created && bettingOpenBlock <= block.number < bettingCloseBlock`.

| Function | Auth | Pre-state / gate | Effect |
|---|---|---|---|
| `createMatch(roleCommit, personaPoolRoot, teeSigner, providerMeta, nonce, playerCount, openBlk, closeBlk, startBlk, deadlineBlk, feeBps, feeBpsDraw)` | `onlyOwner` | — | validates schedule + fee caps + `5 ≤ playerCount ≤ 7` + nonzero `teeSigner` + nonzero `roleCommit` + printable-ASCII non-empty `nonce`; allocates `matchId`; derives & stores `entropySeed = keccak256(prevrandao, matchId, timestamp)`; `state=Created`; emits `MatchCreated`. **No payment.** |
| `betYes/betNo(matchId)` | any (payable) | derived-Open | `MIN_BET ≤ msg.value ≤ MAX_BET_PER_TX`; uint128 overflow guard; updates stake + pool; emits `BetPlaced(…, newPoolYes, newPoolNo)`. |
| `lockBetting(matchId)` | any | `Created && block ≥ closeBlk` | `state=Locked`; emits `BettingLocked`. Optional convenience (settle auto-locks). |
| `settle(matchId, moves, revealedRoles, salt, transcriptCID)` | `onlyOwner` (host) | `state ∈ {Created, Locked} && block ≥ closeBlk && block ≤ deadlineBlk` | verification (§5) → outcome → fee/netPot → `state=Settled`; emits `MatchSettled`. |
| `transferOwnership(newOwner)` | `onlyOwner` | nonzero `newOwner` | rotates the trusted-host role; emits `OwnershipTransferred`. |
| `enterRefundMode(matchId)` | any | `state ∈ {Created, Locked} && block > deadlineBlk` | `state=RefundMode`; emits `RefundModeEntered`. |
| `claim(matchId)` | any | `state == Settled` | per-outcome payout (§6); sets `claimed`; emits `Claimed`. |
| `refund(matchId)` | any | `state == RefundMode` | returns own stake; sets `claimed`; emits `Refunded`. |
| `withdrawProtocolFees()` | `onlyTreasury` | — | sweeps `protocolFeeAccrued` to `protocolTreasury` (never blocks user claims). |

`settle` is **`onlyOwner`** (the host). It was originally permissionless on the theory that
"whoever holds the reveal" could settle, but in practice only the host holds the
`(revealedRoles, salt, moves)` reveal until it broadcasts — so permissionless settle granted
no extra liveness and instead exposed a **reveal front-run**: once the host's settle tx hit
the mempool, a losing bettor could copy the salt and submit a *truncated* (legal-prefix) move
list to force `Draw`, denying the rightful winners. Restricting settle to the owner closes
that; if the host never settles, `enterRefundMode`/`refund` after the deadline is the
permissionless host-failure fallback. No settler bounty (single trusted host is the natural
settler; keeps fee math clean).

## 5. Settlement verification (preserved from Day 5)

Unchanged in mechanics — only the terminal branch changes. In order (cheap → expensive):

1. state/block gates (§4).
2. Commit-reveal: `revealedRoles.length == playerCount` and
   `sha256(roleBytes ++ salt) == roleCommit` (SHA-256 precompile; one byte per role enum then
   the 32-byte salt — matches `engine/src/commit.ts`), then **role-composition check**: the
   revealed multiset must equal the engine COMPOSITION for `playerCount` (5p: 1/1/1/2, 6p:
   1/1/1/3, 7p: 2/1/1/3 of MAFIA/DOCTOR/DETECTIVE/TOWN). The commit check runs first (so a
   mismatched reveal still reverts `"role reveal mismatch"`); composition is checked after,
   blocking a host that *commits* a relabeled set to inflate the mafia count.
3. For each `Move`: `TeeEnvelope.recover(rawResponseBody, reqHashHex, providerType,
   providerIdentity, tlsFingerprint, signature) == teeSigner`, then bind the typed decision to
   the signed body via the offset/slice check against
   `DecisionCodec.jsonEscape(DecisionCodec.encode(nonce, decision))`, then
   `MafiaRules.applyDecision` (reverts on illegal/out-of-order).
4. **Terminal branch (changed):** instead of `require(g.over)`, resolve the outcome:
   - `g.over && g.mafiaWins` → `Yes`; `g.over && !g.mafiaWins` → `No`;
   - `!g.over` (legal but unresolved — e.g. a clean truncation) → `Draw`;
   - then if the resolved side's pool is 0 → override to `Void`.

A *tampered/forged/out-of-order* move still reverts (in `recover`, the binding check, or
`applyDecision`). Only a clean truncation degrades to DRAW — exactly the spec's
anti-truncation property.

## 6. Payout math — four outcomes

`gross = poolYes + poolNo`. Computed once at settlement; cached as `netPot`, `winningPool`,
`outcome`.

| Outcome | At settlement | `claim`/`refund` payout |
|---|---|---|
| **Yes / No** (winningPool > 0) | `fee = gross·feeBps/1e4`; `netPot = gross−fee`; `winningPool = winner side pool`; `protocolFeeAccrued += fee` | `netPot · winnerStake / winningPool` (floor; wei dust stays in contract — `PredictionMarket.md` §7 "simpler approach") |
| **Draw** (game ended unresolved) | `fee = gross·feeBpsDraw/1e4`; `netPot = gross−fee`; `protocolFeeAccrued += fee` | `(stakeYes+stakeNo) · (1e4−feeBpsDraw) / 1e4` |
| **Void** (Yes/No but winningPool == 0) | `fee = 0`; `netPot = gross` | full own stake: `stakeYes + stakeNo` |
| **RefundMode** (deadline passed, never settled) | n/a | full own stake: `stakeYes + stakeNo` |

**Conservation:** `Σ payouts + fee == gross` (within wei-scale floor-division dust for Yes/No;
exact for Void/Refund). `claim`/`refund` use the **pull pattern only** (no payout loops),
guarded by the `claimed` flag against double-spend.

## 7. Deliberate trims / deferrals (flagged, not silent)

- **`entropySeed` enforcement** (anti-grinding, `PredictionMarket.md` §5.1/§5.6): the contract
  *generates & emits* `entropySeed` (cheap, forward-compatible) but does **not** enforce that
  the salt contains it in `settle`. Enforcement requires the engine/server to mix it into the
  salt — a cross-package change outside this bounded session. Core protection (roles committed
  before betting opens) is intact.
- **`personaPoolRoot`**: stored + emitted as an evidence pointer; **not** checked against a
  governance allowlist or attestation leaf (no governance layer in MVP).
- **Settler bounty** (`PredictionMarket.md` §5.4): omitted.
- **Dust sweep timer** (`PredictionMarket.md` §7): omitted; wei-scale per-match dust remains
  in the contract.
- **VRF / beaconValues**: out of scope (no VRF subsystem; see §2.5).
- **ERC-20 betting, LMSR migration** (`PredictionMarket.md` §12.5/§12.6): out of scope (native
  0G only for v1).

## 8. Events (closes a Day-5 gap — the frontend indexer had none)

```solidity
event MatchCreated(uint256 indexed matchId, bytes32 roleCommit, bytes32 entropySeed,
                   bytes32 personaPoolRoot, address teeSigner, uint8 playerCount,
                   uint64 bettingOpenBlock, uint64 bettingCloseBlock,
                   uint64 matchStartBlock, uint64 settlementDeadlineBlock);
event BetPlaced(uint256 indexed matchId, address indexed user, bool isYes,
                uint128 amount, uint128 newPoolYes, uint128 newPoolNo);
event BettingLocked(uint256 indexed matchId, uint128 finalPoolYes, uint128 finalPoolNo);
event MatchSettled(uint256 indexed matchId, Outcome outcome, uint128 netPot,
                   bytes32 transcriptCID);
event Claimed(uint256 indexed matchId, address indexed user, uint256 payout);
event RefundModeEntered(uint256 indexed matchId);
event Refunded(uint256 indexed matchId, address indexed user, uint256 payout);
```

## 9. File plan

- `contracts/contracts/MafiaMarket.sol` — rewritten factory (this spec).
- `contracts/contracts/MafiaTypes.sol` — add `MatchState` / `Outcome` enums (or co-locate in
  the market contract); existing `Role/Phase/Action/Side/Decision` unchanged.
- `contracts/contracts/lib/*` — unchanged.
- `contracts/scripts/deploy.ts` — update to set `owner`/`protocolTreasury` and (optionally)
  create a demo match.
- `contracts/test/helpers/market.ts` — extend `buildSettlement` to also produce createMatch
  args (block schedule, fees); add a `buildTruncatedDraw` / `buildVoid` helper.
- `contracts/test/MafiaMarket.test.ts` — rewritten (see §10).

## 10. Test plan (TDD)

**Lifecycle / guards**
- `betYes/betNo` revert before `bettingOpenBlock`, at/after `bettingCloseBlock`, on a
  nonexistent matchId, below `MIN_BET`, above `MAX_BET_PER_TX`.
- `createMatch` reverts on bad schedule (window too short, no lock buffer, deadline too soon),
  fee over cap, `feeBpsDraw > feeBps`, zero teeSigner, bad playerCount, non-owner.
- `settle` reverts before close block, after deadline, on bad role reveal, and (cheat path)
  on a forged signature or an illegal/out-of-order move.
- `enterRefundMode` reverts before deadline; works after.

**Accounting / payouts**
- Pool accounting equals the sum of stakes exactly.
- Yes/No happy path: on-chain winner == engine winner; winner `claim` payout matches
  `netPot·stake/winningPool` (±1 wei); fee == `gross·feeBps/1e4`.
- **Conservation:** Σ claims + fee == gross (within dust) across a multi-bettor match.
- **Draw:** clean-truncation transcript → `Outcome.Draw`; each bettor refunds
  `ownStake·(1e4−feeBpsDraw)/1e4`.
- **Void:** all bets on the losing side, engine winner is the empty side → `Outcome.Void`;
  every bettor refunds full own stake; nothing trapped.
- **RefundMode:** deadline passes with no settle → `refund` returns full own stake.
- Double-claim / double-refund revert; `claim` reverts for a non-winner; cross-match isolation
  (stake in match A not claimable in match B).
- `withdrawProtocolFees` sweeps to treasury and is `onlyTreasury`.

**Property (fuzz)**
- For any random bet sequence and any forced outcome, conservation holds and no single payout
  exceeds `gross`.

**Preserved cross-layer test**
- `PlayersIntegration` / scripted fixture still settles a real `playMatch` transcript to the
  engine-declared winner through the new lifecycle.

## 11. Exit criteria

- The factory compiles; all unit + property tests green via Hardhat.
- A match can be created, bet on, locked, settled to the on-chain-computed winner, and claimed
  pro-rata net of fee; a forged/dropped-illegal move reverts settle; a clean truncation yields
  DRAW; a zero-bet-winner yields VOID; an un-settled match past its deadline refunds in full.
- No funds are trappable in any reachable state (proven by the Void + Refund tests).
- `STATUS.md` updated to reflect the two closed Day-5 limitations and the new market layer.

## 12. Open items (non-blocking)

- **Demo block windows.** `MIN_BETTING_WINDOW = 100` blocks on a fast testnet is fine, but the
  demo runbook must set realistic open/close/deadline blocks relative to current height. Tests
  use Hardhat's `mine`/`setNextBlock` to fast-forward.
- **Frontend/server rewiring.** The server/frontend currently target a single deployed
  address with the old ABI; Day 6 must adopt the factory ABI (`matchId` everywhere) and the
  new events. Out of scope for this session (logic only).
