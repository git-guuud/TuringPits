> **⚠️ SUPERSEDED (2026-06-18).** This document describes an earlier design (host seed/bond, CREATED/OPEN/LOCKED/SETTLED/CLAIMED/REFUNDED states, settler bounty, dust-sweep). The **shipped** contract follows `docs/superpowers/specs/2026-06-18-parimutuel-market-factory-design.md` instead: no host seed/bond; states None/Created/Locked/Settled/RefundMode; a Void outcome for the empty-winning-pool case; full-stake refund mode; no settler bounty or dust-sweep timer. Kept for design rationale only — **do not implement against this doc.**

# Turing Pits — Market Logic Specification
## The Parimutuel Faction-Win Market (v1)

This document specifies the **exact** market mechanics: state machine, math, contract storage, function signatures, edge cases, and gas-conscious implementation notes.

---

## 1. Market Type Decision: Why Parimutuel

Before the math, the *why*:

| Mechanism | Pros | Cons | Verdict |
|---|---|---|---|
| **Parimutuel pool** | Always solvent; no LP needed; simple; matches horse-racing / pool-betting mental model | Final odds unknown until close; no continuous price | ✅ **Chosen for v1** |
| **LMSR (Logarithmic Market Scoring Rule)** | Continuous price; classic prediction-market UX | Requires subsidizer to seed `b`; bounded loss for house; complex math on-chain | ❌ v2 candidate |
| **CPMM (Uniswap-style)** | Familiar AMM | Requires balanced LP; insolvent on extreme skew unless capped | ❌ Wrong primitive for binary settlement |
| **Order book** | Best price discovery | Heavy on-chain or needs off-chain matching | ❌ Out of scope for MVP |

**Decision:** Parimutuel. Simple, solvent-by-construction, and the "odds shift live as people bet" UX is *more* dramatic for a livestream than fixed LMSR pricing — which fits the spectacle.

---

## 2. Market Lifecycle State Machine

```
        ┌─────────────┐
        │   CREATED   │  ← match created, role commit posted, host bond locked
        └──────┬──────┘
               │ block >= betting_open_block
               ▼
        ┌─────────────┐
        │    OPEN     │  ← bets accepted on YES (Mafia wins) and NO (Town wins)
        └──────┬──────┘
               │ block >= betting_close_block
               ▼
        ┌─────────────┐
        │   LOCKED    │  ← no more bets; match runs off-chain; awaiting settlement
        └──────┬──────┘
               │
       ┌───────┴────────────────┐
       │                        │
       ▼                        ▼
┌─────────────┐         ┌────────────────┐
│   SETTLED   │         │  REFUND_MODE   │  ← settlement_deadline passed without valid settle()
│ (YES/NO/DRAW)│        │                │
└──────┬──────┘         └────────┬───────┘
       │                         │
       ▼                         ▼
┌─────────────┐         ┌────────────────┐
│   CLAIMED   │         │   REFUNDED     │
└─────────────┘         └────────────────┘
```

**Allowed state transitions only.** Any function call invalid for the current state reverts.

---

## 3. Core Math

### 3.1 Variables

| Symbol | Meaning |
|---|---|
| `P_yes` | Total YES pool (sum of all YES stakes, including host seed) |
| `P_no` | Total NO pool (sum of all NO stakes, including host seed) |
| `P_total` | `P_yes + P_no` |
| `s_i^yes` | User `i`'s stake on YES |
| `s_i^no` | User `i`'s stake on NO |
| `f` | Protocol fee, in basis points (e.g., `f = 200` → 2%) |
| `S` | Symmetric host seed per side (e.g., 10 0G each) |

### 3.2 Live Odds Display (read-only, off-chain)

At any moment during `OPEN`:

```
implied_prob_yes = P_yes / P_total
implied_prob_no  = P_no  / P_total

payout_multiplier_yes = (P_total * (10000 - f)) / (P_yes * 10000)
payout_multiplier_no  = (P_total * (10000 - f)) / (P_no  * 10000)
```

The frontend shows these as decimal odds (e.g., "YES pays 2.34×"). Multipliers shift with every new bet — this is the live drama.

### 3.3 Settlement Payout

Let `W` = winning side's pool, `L` = losing side's pool.

```
gross_pot     = W + L
fee           = gross_pot * f / 10000
net_pot       = gross_pot - fee
user_i_payout = (s_i^W / W) * net_pot
```

**Invariant:** `Σ user_i_payout + fee == gross_pot` (must hold exactly; rounding dust accumulates to fee bucket — see §7).

### 3.4 Draw Payout

If settlement returns `DRAW`:

```
fee           = gross_pot * f_draw / 10000   // f_draw < f, e.g. 50 bps
user_i_refund = (s_i^yes + s_i^no) * (10000 - f_draw) / 10000
```

Lower fee on draws because no "winning" happened — we only cover gas.

### 3.5 Refund Mode Payout

If `REFUND_MODE` (no valid settlement by deadline):

```
user_i_refund      = s_i^yes + s_i^no             // 100% refund
host_bond_per_user = host_bond * (s_i^yes + s_i^no) / (P_total - 2*S)
```

The host bond is distributed pro-rata to *user* stakes (excluding the host's own seed) as compensation for the cancelled match.

---

## 4. Contract Storage Layout

```solidity
struct Match {
    // --- Lifecycle ---
    MatchState state;              // CREATED / OPEN / LOCKED / SETTLED / REFUND_MODE / CLAIMED / REFUNDED
    uint64 bettingOpenBlock;
    uint64 bettingCloseBlock;
    uint64 matchStartBlock;
    uint64 settlementDeadlineBlock;

    // --- Commit-reveal ---
    bytes32 roleCommit;            // hash(roleAssignment || salt)
    bytes32 entropySeed;           // emitted by contract at create time, mixed into salt
    bytes32 personaPoolRoot;       // Merkle root of approved personas for this match

    // --- Pools ---
    uint128 poolYes;               // includes host seed
    uint128 poolNo;                // includes host seed
    uint128 hostSeedPerSide;       // S
    uint128 hostBond;              // forfeitable bond

    // --- Settlement result ---
    Outcome outcome;               // UNSET / YES / NO / DRAW
    uint128 netPot;                // cached at settlement for cheap claims
    uint128 winningPool;           // W at settlement (excluding fee deduction context)

    // --- Fees ---
    uint16 feeBps;                 // e.g., 200 = 2%
    uint16 feeBpsDraw;             // e.g., 50  = 0.5%
}

mapping(uint256 => Match) public matches;                       // matchId => Match
mapping(uint256 => mapping(address => uint128)) public stakeYes; // matchId => user => stake
mapping(uint256 => mapping(address => uint128)) public stakeNo;  // matchId => user => stake
mapping(uint256 => mapping(address => bool))    public claimed;  // matchId => user => claimed?

uint128 public protocolFeeAccrued;
address public protocolTreasury;
```

**Gas notes:**
- Pools and stakes use `uint128` so two values pack into one storage slot.
- Lifecycle blocks packed into one slot (4 × uint64 = 256 bits).
- Per-user storage is exactly 3 slots regardless of bet count (yes stake, no stake, claimed flag).

---

## 5. Function Specification

### 5.1 `createMatch`

```solidity
function createMatch(
    bytes32 roleCommit,
    bytes32 personaPoolRoot,
    uint64 bettingOpenBlock,
    uint64 bettingCloseBlock,
    uint64 matchStartBlock,
    uint64 settlementDeadlineBlock,
    uint16 feeBps,
    uint16 feeBpsDraw
) external payable returns (uint256 matchId)
```

**Validations:**
- `bettingOpenBlock > block.number`
- `bettingCloseBlock > bettingOpenBlock + MIN_BETTING_WINDOW` (e.g., 100 blocks)
- `matchStartBlock >= bettingCloseBlock + LOCK_BUFFER` (e.g., 5 blocks — prevents same-block last-look)
- `settlementDeadlineBlock > matchStartBlock + MIN_MATCH_DURATION`
- `feeBps <= MAX_FEE_BPS` (e.g., 500 = 5%)
- `feeBpsDraw <= feeBps`
- `msg.value == 2 * hostSeedPerSide + hostBond` (host funds both seed and bond in one tx)
- `personaPoolRoot ∈ approvedPersonaRoots` (governance-controlled allowlist)

**Effects:**
- Generates `entropySeed = keccak256(block.prevrandao, matchId, block.timestamp)`.
- Initializes `poolYes = poolNo = hostSeedPerSide`.
- Emits `MatchCreated(matchId, entropySeed, ...)`.
- State → `CREATED`.

**The `entropySeed` is the value the Sequencer MUST include in the salt** to prevent grinding. The contract enforces this at reveal (see §5.6).

### 5.2 `betYes` / `betNo`

```solidity
function betYes(uint256 matchId) external payable;
function betNo (uint256 matchId) external payable;
```

**Validations:**
- State is `OPEN` (auto-transition from `CREATED` if `block.number >= bettingOpenBlock`).
- `block.number < bettingCloseBlock`.
- `msg.value >= MIN_BET` (e.g., 0.01 0G).
- `msg.value <= MAX_BET_PER_TX` (e.g., 10,000 0G — anti-whale griefing).
- `poolYes + msg.value <= type(uint128).max` (overflow guard).

**Effects:**
- `stakeYes[matchId][msg.sender] += msg.value` (or `stakeNo`).
- `poolYes += msg.value` (or `poolNo`).
- Emits `BetPlaced(matchId, user, side, amount, newPoolYes, newPoolNo)` — frontend uses this to update live odds.

**No fee on entry.** Fees are only deducted at payout.

### 5.3 `lockBetting` (anyone can call)

```solidity
function lockBetting(uint256 matchId) external;
```

Permissionless transition `OPEN → LOCKED` once `block.number >= bettingCloseBlock`. Not strictly required (other functions can check the block directly), but useful for event emission and gas refunds on subsequent calls.

### 5.4 `settle`

```solidity
function settle(
    uint256 matchId,
    bytes32[] calldata roleAssignment,    // role per player index
    bytes32 salt,
    Turn[] calldata turns,                // ordered structured decisions
    bytes[] calldata signatures,          // TEE signatures per turn
    bytes32[] calldata beaconValues,      // VRF outputs per turn
    bytes32 transcriptCID                 // 0G Storage CID of full transcript
) external;
```

**Validations (in order, cheap → expensive):**
1. State is `LOCKED`.
2. `block.number <= settlementDeadlineBlock` (else falls to refund mode — see §5.6).
3. `keccak256(abi.encodePacked(roleAssignment, salt)) == roleCommit`.
4. `salt` contains `entropySeed` (e.g., last 32 bytes of salt preimage). **Anti-grinding check.**
5. For each turn `t`:
   - `signatures[t]` recovers to a key in the approved provider set.
   - The selected provider matches `VRF(matchId, t, prior_block_hash)`.
   - `beaconValues[t]` matches the contract-derivable VRF output.
   - `prior_state_hash[t] == hash(state[t-1])` (state-chain continuity).
   - The persona CID + role bound in the attestation match `roleAssignment` and a leaf in `personaPoolRoot`.
6. Run Solidity Mafia rule engine over `turns` → produces `outcome ∈ {YES, NO, DRAW}`.

**Effects on success:**
- `outcome` stored.
- `winningPool = (outcome == YES) ? poolYes : poolNo` (irrelevant for DRAW).
- `gross = poolYes + poolNo`.
- `fee = gross * (outcome == DRAW ? feeBpsDraw : feeBps) / 10000`.
- `netPot = gross - fee`.
- `protocolFeeAccrued += fee`.
- Host bond returned to host.
- Transcript CID stored.
- State → `SETTLED`.
- Emits `MatchSettled(matchId, outcome, netPot, transcriptCID)`.

**Caller incentive:** the settle caller (not necessarily the host) receives a small bounty from the fee pool (e.g., 5% of `fee`) to incentivize permissionless settlement.

### 5.5 `claim`

```solidity
function claim(uint256 matchId) external;
```

**Validations:**
- State is `SETTLED`.
- `!claimed[matchId][msg.sender]`.
- User has a stake on the winning side (or any stake, if DRAW).

**Payout calculation:**

```solidity
if (outcome == YES) {
    uint256 userStake = stakeYes[matchId][msg.sender];
    require(userStake > 0, "no winning stake");
    payout = uint256(netPot) * userStake / winningPool;
} else if (outcome == NO) {
    uint256 userStake = stakeNo[matchId][msg.sender];
    require(userStake > 0, "no winning stake");
    payout = uint256(netPot) * userStake / winningPool;
} else { // DRAW
    uint256 totalStake = stakeYes[matchId][msg.sender] + stakeNo[matchId][msg.sender];
    require(totalStake > 0, "no stake");
    payout = totalStake * (10000 - feeBpsDraw) / 10000;
}
```

**Effects:**
- `claimed[matchId][msg.sender] = true`.
- Transfer `payout` to user.
- Emits `Claimed(matchId, user, payout)`.

**Pull pattern only** — never push payouts in a loop. Prevents griefing and gas-bomb attacks.

### 5.6 `enterRefundMode` + `refund`

```solidity
function enterRefundMode(uint256 matchId) external;
function refund(uint256 matchId) external;
```

**`enterRefundMode`** is permissionless once `block.number > settlementDeadlineBlock` and state is `LOCKED`.

**Effects:**
- State → `REFUND_MODE`.
- Host bond is moved into a refund pool: `refundBondPool[matchId] = hostBond`.
- `hostBond = 0`.
- Emits `RefundModeEntered(matchId)`.

**`refund`** (per user):

```solidity
uint256 userStake = stakeYes[matchId][msg.sender] + stakeNo[matchId][msg.sender];
require(userStake > 0, "no stake");
require(!claimed[matchId][msg.sender], "already refunded");

uint256 userPoolSansSeed = (poolYes + poolNo) - 2 * hostSeedPerSide;
uint256 bondShare = refundBondPool[matchId] * userStake / userPoolSansSeed;

claimed[matchId][msg.sender] = true;
payable(msg.sender).transfer(userStake + bondShare);
```

The host's symmetric seed is *not* refunded to users — it returns to nobody (forfeited as part of the broken-match penalty along with the bond going to users).

### 5.7 `withdrawProtocolFees`

```solidity
function withdrawProtocolFees() external;  // onlyTreasury
```

Sweeps `protocolFeeAccrued` to `protocolTreasury`. Separate from match logic so it can never block user claims.

---

## 6. The Solidity Mafia Rule Engine (settlement-time only)

This runs *inside* `settle()` after signature verification passes. It is a **pure function** over the verified turn list.

```solidity
function _resolveOutcome(
    Turn[] calldata turns,
    bytes32[] calldata roleAssignment
) internal pure returns (Outcome) {
    GameState memory s = _initialState(roleAssignment);

    for (uint i = 0; i < turns.length; i++) {
        s = _applyTurn(s, turns[i]);
        if (s.mafiaCount == 0) return Outcome.NO;            // Town wins
        if (s.mafiaCount >= s.townCount) return Outcome.YES; // Mafia wins
    }

    // Reached end of submitted turns without resolution
    return Outcome.DRAW;
}
```

**Key design choices:**
- The engine is **stateless across matches** — no storage writes, pure computation.
- DRAW is the explicit fallback when turns end without a faction-win condition. This eliminates the "what if the Sequencer truncates?" attack: truncation just produces DRAW, which refunds bettors and forfeits the host bond.
- `_applyTurn` validates the turn was *legal* under Mafia rules (e.g., dead players can't vote). Invalid turn → revert entire settlement.

---

## 7. Rounding & Dust Handling

Integer division in payout math loses precision. Strategy:

1. Compute each user's payout via `(netPot * userStake) / winningPool`.
2. Track `paidOut` cumulatively as users claim.
3. The *last* claim in a match (detectable by `paidOut + nextPayout >= netPot`) receives `netPot - paidOut` instead of the computed value. This absorbs all dust.
4. If users never claim (forgotten stakes), dust stays in the contract → swept to `protocolFeeAccrued` after a `DUST_SWEEP_DELAY` (e.g., 90 days post-settlement).

**Alternative (simpler):** dust accumulates silently to `protocolFeeAccrued` on every claim:

```solidity
uint256 computed = uint256(netPot) * userStake / winningPool;
// (no special last-claim logic; tiny dust per match goes to fees)
```

For MVP: **use the simpler approach.** Dust per match is on the order of wei.

---

## 8. Anti-Manipulation Market-Level Defenses

These are *market-specific* defenses on top of the global ones (commit-reveal, TEE, VRF):

### 8.1 No Bet Cancellation
Once placed, a bet cannot be withdrawn before settlement. Prevents:
- Information-driven exits (whale sees pool skew and pulls out).
- Front-running games where bots place + cancel to manipulate displayed odds.

### 8.2 Per-Tx Bet Cap
`MAX_BET_PER_TX` (e.g., 10,000 0G). Whales must split across multiple txs, giving the market and other bettors time to react.

### 8.3 Minimum Betting Window
`MIN_BETTING_WINDOW` (e.g., ~30 minutes worth of blocks). Prevents flash-betting attacks where a host opens and closes betting in seconds with collusion.

### 8.4 Lock Buffer
`LOCK_BUFFER` (≥5 blocks between `bettingCloseBlock` and `matchStartBlock`). Prevents same-block last-look where someone observes match-start mempool and bets in the same block.

### 8.5 Host Bond Sizing
Host bond should be ≥ `2 * MAX_BET_PER_TX` so that even if the host griefs the match, the bond meaningfully compensates affected bettors.

### 8.6 Pool Skew Disclosure
The contract emits `BetPlaced` events with updated pool totals. The frontend MUST display live skew prominently — informed bettors can avoid mispricing. This is a UX requirement, not a contract one, but it's part of the market spec.

---

## 9. Events (for frontend + indexers)

```solidity
event MatchCreated(
    uint256 indexed matchId,
    bytes32 roleCommit,
    bytes32 entropySeed,
    bytes32 personaPoolRoot,
    uint64 bettingOpenBlock,
    uint64 bettingCloseBlock,
    uint64 matchStartBlock,
    uint64 settlementDeadlineBlock
);

event BetPlaced(
    uint256 indexed matchId,
    address indexed user,
    bool isYes,
    uint128 amount,
    uint128 newPoolYes,
    uint128 newPoolNo
);

event BettingLocked(uint256 indexed matchId, uint128 finalPoolYes, uint128 finalPoolNo);

event MatchSettled(
    uint256 indexed matchId,
    Outcome outcome,
    uint128 netPot,
    bytes32 transcriptCID,
    address settler,
    uint128 settlerBounty
);

event Claimed(uint256 indexed matchId, address indexed user, uint256 payout);

event RefundModeEntered(uint256 indexed matchId);
event Refunded(uint256 indexed matchId, address indexed user, uint256 payout);
```

The indexer (or 0G subgraph equivalent) reconstructs:
- Live odds history per match (from `BetPlaced` deltas).
- User P/L (from `BetPlaced` + `Claimed`).
- Match outcome history (from `MatchSettled`).

---

## 10. Worked Example

**Setup:** Match #42, host seeds 10 0G per side, fee = 2%, fee_draw = 0.5%.

**Betting opens.** Pools: `YES=10, NO=10`. Implied prob each: 50%.

**Activity during OPEN:**
- Alice bets 50 on YES → `YES=60, NO=10`. Live YES multiplier: `(70 * 0.98) / 60 = 1.143×`.
- Bob bets 30 on NO → `YES=60, NO=40`. YES mult: `(100 * 0.98) / 60 = 1.633×`. NO mult: `(100 * 0.98) / 40 = 2.45×`.
- Carol bets 20 on YES → `YES=80, NO=40`. YES mult: `1.47×`. NO mult: `2.94×`.

**Betting closes.** Final pools: `YES=80, NO=40`. `gross_pot = 120`.

**Match runs. Mafia wins → outcome = YES.**

**Settlement:**
- `fee = 120 * 0.02 = 2.4`
- `net_pot = 117.6`
- `winning_pool = 80` (YES)

**Claims:**
- Alice: `117.6 * 50 / 80 = 73.5` (profit: +23.5 on 50 staked, 1.47× return)
- Carol: `117.6 * 20 / 80 = 29.4` (profit: +9.4 on 20 staked, 1.47× return)
- Host seed YES (10): `117.6 * 10 / 80 = 14.7` (host gets back seed + small profit)
- Bob: loses 30 (NO side lost)
- Host seed NO (10): lost (absorbed into the winning side's pot)

**Conservation check:** `73.5 + 29.4 + 14.7 = 117.6 = net_pot` ✅

The host's NO seed (10) effectively subsidizes winners — this is the cost of bootstrapping liquidity. Acceptable for v1.

---

## 11. Parameters Table (MVP Defaults)

| Parameter | Value | Notes |
|---|---|---|
| `MIN_BET` | 0.01 0G | Anti-dust |
| `MAX_BET_PER_TX` | 10,000 0G | Anti-whale |
| `MIN_BETTING_WINDOW` | ~30 min in blocks | Anti-flash-betting |
| `LOCK_BUFFER` | 5 blocks | Anti-last-look |
| `MIN_MATCH_DURATION` | ~5 min in blocks | Realistic match length floor |
| `MAX_FEE_BPS` | 500 (5%) | Per-match cap |
| `feeBps` (default) | 200 (2%) | Standard market fee |
| `feeBpsDraw` (default) | 50 (0.5%) | Gas-cover only on draws |
| `hostSeedPerSide` | 10 0G | Liquidity bootstrap |
| `hostBond` | 50 0G | ≥ 5× `MAX_BET_PER_TX`? **See open question §12** |
| `SETTLER_BOUNTY_BPS` | 500 (5% of fee) | Settlement incentive |
| `DUST_SWEEP_DELAY` | 90 days | Unclaimed sweep timer |

---

## 12. Open Questions / Design Decisions Needed

These are calls *you* need to make as the market owner:

1. **Host bond sizing.** Currently suggested 50 0G — but if individual bets can reach 10,000 0G, that's woefully under-collateralized. Options:
   - (a) Lower `MAX_BET_PER_TX` to keep bond meaningful.
   - (b) Make host bond a function of total pool (require top-ups as pool grows).
   - (c) Accept that host bond is symbolic and rely on reputation.

2. **Multi-host model.** Is there one canonical host per match, or can anyone create matches? If anyone — need a registry, staking requirement to prevent spam.

3. **Bet cancellation grace period.** Strict "no cancellation" is cleanest, but some markets offer a brief grace period (e.g., 5 min after placement). Recommend **no** for MVP.

4. **Fee recipient governance.** Hard-coded treasury vs. governable vs. burn-to-0G. Easiest: hard-coded for MVP.

5. **Multi-currency support.** v1 takes only native 0G. Do you want ERC-20 betting (USDC-equivalent) later? If yes, plan now (use `IERC20.safeTransferFrom` in `bet*`, payouts via pull).

6. **LMSR migration path.** If you want to move to LMSR later, the parimutuel pool structure can be wrapped: at v2 launch, switch market mode flag per-match. Worth designing the storage layout now to accommodate (add unused `marketType` enum field).

7. **Front-end odds caching.** Live odds shift with every bet. Decide: contract reads (slow) or event-driven indexer (fast, complex). Recommend indexer.

---

## 13. Test Plan (Market-Only)

Before integrating with TEE settlement, validate the market in isolation with a `MockSettler` that lets you force outcomes:

**Unit tests:**
- `betYes` / `betNo` reverts outside `OPEN` window.
- Pool accounting matches sum of stakes exactly.
- `claim` reverts if user has no winning stake.
- `claim` payout matches formula on ±1 wei.
- Conservation: sum of all claims + fee == gross_pot.
- Draw refunds match formula.
- Refund mode distributes bond pro-rata.
- Double-claim reverts.
- `MAX_BET_PER_TX` and `MIN_BET` enforced.

**Property tests (fuzz):**
- For any random sequence of bets ending in any outcome, conservation holds.
- For any `(P_yes, P_no, outcome)`, no user payout exceeds `gross_pot`.
- For any user, `payout - userStake` correctly signed (positive iff won, negative iff lost, ~0 iff draw).

**Scenario tests:**
- Skewed pool: 99% YES, Mafia wins → tiny multiplier for YES, OK.
- Skewed pool: 99% YES, Town wins → massive multiplier for NO, OK.
- Single bettor on winning side: gets entire `net_pot`.
- No bettors at all on winning side (only host seed): host claims entire `net_pot` minus dust.

---

## 14. What You Need from Other Subsystems

So the market contract can do its job, the other teams must deliver:

| From | What | When |
|---|---|---|
| **Sequencer team** | `roleCommit`, `entropySeed`-based salt, block schedule | At `createMatch` |
| **TEE team** | Signature format spec; provider key registry | Before settle() integration |
| **VRF team** | On-chain VRF output retrievable by `(matchId, turn, blockHash)` | Before settle() integration |
| **Persona team** | Merkle root of approved persona pool | Before `createMatch` |
| **Storage team** | Transcript CID format | At `settle()` |
| **Frontend team** | Indexer for `BetPlaced` events; live odds UI | Before public launch |

---

## Summary

This spec gives you:
- **Parimutuel mechanism** — solvent by construction, simple math, no LP risk.
- **Complete state machine** — every state transition is explicit and gated.
- **Exact payout formulas** with conservation guarantees.
- **All edge cases handled** — draws, refund mode, dust, double-claims, host griefing.
- **Manipulation defenses** specific to the market layer (caps, lock buffer, no cancellation).
- **Storage layout** optimized for gas (slot packing, pull-only claims).
- **Open questions** flagged so you don't make implicit decisions.