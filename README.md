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
- **Per-seat Fate side markets (categorical):** one auto-created market per seat asking *"what
  happens to this seat?"* — five buckets: **Survives**, **Out · R1**, **Out · R2**, **Out · R3**,
  **Out · R4+**. A seat's market closes the moment that seat falls (its fate is then decided).
- **Per-round "Who hangs?" side markets (categorical, recurring):** for each day vote, a market over
  the living seats plus a **"No one"** outcome (a tie / no elimination). Round 1 opens with the match;
  the host floats a fresh market as each later round begins, and freezes it once that round's vote
  resolves. Only the currently-bettable round shows live; resolved rounds drop to History.
- Both side-market kinds resolve from the **same on-chain-verified final game state** as the faction
  market — no new trust and no extra settlement transaction.
- **Mechanism:** parimutuel pools. The faction market is binary (one YES pool, one NO pool); each
  categorical side market holds one pool per outcome. Backers of the resolved (winning) outcome split
  the pot pro-rata, minus a small protocol fee. Always solvent regardless of bet skew. If nobody
  backed the winning outcome, that market Voids and every stake is refunded.
- **Currency:** wagers are placed in **CHIP**, a faucet-mintable mock ERC20 (`MockBetToken`) — test
  money with no value. Tap **"Get test tokens"** in the UI to mint some.
- **Optional gasless betting (EIP-2771):** if the host runs a funded relayer, a spectator with **zero
  native 0G** can still play — the wallet signs each action off-chain and a backend relayer submits it
  through a trusted `Forwarder` and pays the gas, while the user stays the on-chain bettor. It's the
  default whenever the relayer is live and funded (a "⛽ Gasless" toggle opts out); otherwise the UI
  falls back to the normal path where gas is paid in native 0G. Real on-chain mechanism, not a mock.
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
| `MafiaMarket`           | `0xdF955ED2D8C5D1F3C4Acfdb8e26885a25a79b917` |
| `MockBetToken` (CHIP)   | `0x48cF05921C8f042Ed337f56F947542aB89691aBb` |
| `Forwarder` (EIP-2771)  | `0xaD341c0A01eaA8EBe8B9aee9FD1364C619fB770A` |

RPC `https://evmrpc-testnet.0g.ai` · Explorer https://chainscan-galileo.0g.ai · Faucet
https://faucet.0g.ai (native 0G for gas; CHIP comes from the in-app faucet). `MafiaMarket` is a
multi-match factory and also hosts the per-seat Fate and per-round "Who hangs?" categorical side markets.

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
