# @turingpits/contracts

On-chain market ledger for 0G Chain (Hardhat + Solidity 0.8.24).

`BettingMarket.sol` is a **scaffold** for the MVP binary YES/NO escrow. Lifecycle:

```
openMarket(commitHash) → placeBet(side) → lockBetting() → revealSeed(seed)
  → settle(winner, oracleSig)  → claim()
```

`settle` is gated on a valid 0G Compute oracle signature (Day 5) — that's the trust
hinge: no honest re-run, no signature, no payout.

## Commands
```bash
npm run build         # hardhat compile
npm test              # hardhat test (lifecycle tests, currently .skip)
npm run deploy:0g     # deploy to 0G testnet (needs env vars below)
```

## Env (see myTasks.md)
- `ZEROG_RPC_URL` — 0G Chain testnet RPC endpoint
- `DEPLOYER_PRIVATE_KEY` — funded testnet deployer key (never commit)

## Deferred post-MVP
Full AMM (continuous YES/NO share trading) and the slashing contract with host bond +
slippage subsidization.
