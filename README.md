# Turing Pits

A gamified, decentralized AI vs. AI prediction market on the [0G network](https://0g.ai).
Users place live bets on the outcomes of autonomous AI agents battling in 100%
deterministic chess matches. The protocol runs as an "Optimistic Game Engine": a fast
Web2 live stream backed by trustless 0G verification.

See [`IDEA.md`](./IDEA.md) for the full vision and [`TODO.md`](./TODO.md) for the
week-long plan to the Jun 23 "Proof of Battle" MVP. Live status lives in
[`STATUS.md`](./STATUS.md); out-of-code setup tasks for the human are in
[`myTasks.md`](./myTasks.md).

## Monorepo layout (npm workspaces)

| Package        | Role                                  | IDEA layer            |
| -------------- | ------------------------------------- | --------------------- |
| `engine/`      | Deterministic chess match engine      | Game logic            |
| `server/`      | Sequencer + WebSocket move streaming  | Live Arena (off-chain)|
| `contracts/`   | Betting/escrow contracts (Solidity)   | Market Ledger (0G Chain)|
| `storage/`     | 0G Storage uploads/retrieval          | Evidence Layer        |
| `oracle/`      | 0G Compute replay verifier + attest   | Settlement Oracle     |
| `frontend/`    | Live arena UI + betting panel         | Live Arena (UI)       |

## Architecture (the verifiable loop)

```
                commit(seedHash)            placeBet / lock / claim
   server  ───────────────────────►  ┌──────────────────────────┐
     │                                │   BettingMarket (0G Chain)│
     │  run deterministic match       └──────────────────────────┘
     │  (engine: seed + agents → PGN)            ▲  settle(winner, sig)
     │                                           │
     ▼  upload agents (pre) + PGN (post)         │
  ┌──────────────┐   pull agents/PGN/seed   ┌────┴───────────────┐
  │  0G Storage  │ ───────────────────────► │  0G Compute oracle │
  └──────────────┘                          │  re-run → verify   │
                                            │  PASS → sign       │
                                            └────────────────────┘
```

If the streamed match diverges from a clean re-run of the agents' locked code, 0G
Compute refuses to sign and the escrow cannot settle.

## Getting started

```bash
npm install          # installs all workspaces
npm run build        # build everything that has a build step
npm test             # run all workspace tests
```

> Most 0G-touching packages need testnet credentials/funds first — see
> [`myTasks.md`](./myTasks.md).
