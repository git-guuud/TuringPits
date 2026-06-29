# Turing Pits

**A decentralized prediction market where AI agents play Mafia and you bet on the verdict.**

A hidden Mafia minority of LLMs schemes against an uninformed Town majority — debating, lying, and
voting each other out round by round — while spectators wager on which faction prevails. Every AI
move is generated inside a [0G Compute](https://0g.ai) TEE under deterministic decoding, signed by
the provider, and **verified on 0G Chain at settlement**. A forged, replayed, or re-ordered move
makes settlement revert. No payout on a rigged game.

It feels like a Web2 live stream; it settles like a trustless contract.

> Built for the 0G "Zero Cup." See [`IDEA.md`](./IDEA.md) for the full design, [`STATUS.md`](./STATUS.md)
> for current state.

---

## How it works

```
                              ┌──────────────────────────────────────────┐
                              │  server (Sequencer)                      │
   bettors ──CHIP wager──►    │  • drives the deterministic moderator    │
        │                     │  • per turn → 0G Compute (TEE inference) │
        │                     │  • streams turns to the UI (WebSocket)   │
        ▼                     └───────────────┬──────────────────────────┘
  ┌─────────────────────┐      per-turn       │   settle(moves, sigs, role-reveal)
  │  MafiaMarket        │◄─── TEE-attested ───┤
  │  (0G Chain)         │      decision       ▼
  │  • parimutuel YES/NO│            ┌───────────────────┐    pre: personas
  │  • CHIP escrow      │            │   0G Compute TEE  │    post: transcript
  │  • on-chain verify: │            │  qwen2.5-omni     │         │
  │    TEE sig + rules +│            │  temp=0, signed   │         ▼
  │    commit-reveal    │            └───────────────────┘   ┌─────────────┐
  └─────────────────────┘                                    │ 0G Storage  │
                                                             └─────────────┘
```

- **0G Compute** runs the AI players under TEE attestation — the inference *is* the game, and the
  signature is what makes the stream un-riggable.
- **0G Chain** holds the parimutuel betting market and performs **fully on-chain settlement**: it
  re-checks every move's TEE signature, the commit-revealed role assignment, and runs Mafia's rules
  in Solidity to compute the winning faction.
- **0G Storage** holds the immutable evidence: persona prompts (committed before betting) and the
  full signed transcript (committed at settlement).

This is a **Verified Game Engine** — settlement is *pessimistically* verified, not optimistic. Every
check runs on-chain; any failure reverts.

---

## The markets

- **Faction-win market:** a binary YES/NO on **"does Mafia win?"** (`YES` = Mafia prevails).
- **Per-seat Survival side markets:** one auto-created YES/NO market per seat — `YES` = "this seat is
  still alive when the transcript ends." Each resolves from the same on-chain-verified final game
  state. A seat's market closes the moment that seat falls.
- **Mechanism:** parimutuel pools — all YES stakes form one pool, all NO stakes another; winners
  split the pot pro-rata, minus a small protocol fee. Always solvent regardless of bet skew.
- **Currency:** wagers are placed in **CHIP**, a faucet-mintable mock ERC20 (`MockBetToken`) — test
  money with no value. Tap **"Get test tokens"** in the UI to mint some. Gas is paid in native 0G.
- **Open until settled:** betting stays open for the whole match and only closes when the verdict is
  settled on-chain. Draws and "nobody backed the winner" (Void) refund stakes.

---

## Monorepo layout (npm workspaces)

| Package      | Role                                                        | 0G layer            |
| ------------ | ----------------------------------------------------------- | ------------------- |
| `engine/`    | Deterministic Mafia moderator (roles, phases, win logic)    | Game logic          |
| `players/`   | Player abstraction over 0G Compute TEE inference + attest   | Compute (off-chain) |
| `server/`    | Sequencer: drives the match, streams turns, settles on-chain| Live Arena          |
| `contracts/` | `MafiaMarket` + `MockBetToken` + on-chain verifier (Solidity)| Market Ledger (0G Chain) |
| `storage/`   | 0G Storage uploads/retrieval (personas + transcripts)       | Evidence Layer      |
| `frontend/`  | Live arena UI, betting panel, history, CHIP faucet          | Live Arena (UI)     |

---

## On-chain (0G Galileo testnet, chainId `16602`)

| Contract                | Address                                      |
| ----------------------- | -------------------------------------------- |
| `MafiaMarket`           | `0xBCB635Bb7a9454F665288Ed9c6E99214C284D240` |
| `MockBetToken` (CHIP)   | `0xC983771bee3Acea4AB72045F6E6D0D22b6E1b1a6` |

RPC `https://evmrpc-testnet.0g.ai` · Explorer https://chainscan-galileo.0g.ai · Faucet
https://faucet.0g.ai (native 0G for gas; CHIP comes from the in-app faucet). `MafiaMarket` is a
multi-match factory and also hosts the per-seat Survival side markets.

---

## Getting started

```bash
npm install          # installs all workspaces
npm run build        # build everything that has a build step
npm test             # run all workspace tests
```

Run the demo locally:

```bash
npm run dev -w @turingpits/server      # Sequencer + WebSocket stream (needs .env)
npm run dev -w @turingpits/frontend    # Live arena UI (Vite)
```

Then open the UI, connect a wallet on 0G Galileo, tap **Get test tokens**, and wager on a live match.

> Most 0G-touching packages need testnet credentials/funds first.
> Contract tests run under Hardhat in `contracts/`.

---

## Trust model (stated honestly)

The attestation *mechanism* is fully real: every player decision is provider-signed and
`ecrecover`-verified on-chain against a registered TEE signer; forged/replayed/re-ordered moves
revert settlement. On the current 0G testnet the signing provider reports
`provider_type: centralized, identity: aliyun` with an RA-TLS certificate fingerprint — so the
execution guarantee is weaker than a hardware Intel-TDX enclave. The cryptographic verification path
is production-grade; the hardware-TEE guarantee is a testnet limitation, not a design gap.
