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
  │  • parimutuel props │            ┌───────────────────┐    pre: personas
  │  • CHIP escrow      │            │   0G Compute TEE  │    post: transcript
  │  • on-chain verify: │            │  qwen3.6-plus     │         │
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

Every market is a **categorical parimutuel prop** — one pool per outcome — and they **all resolve from
the same on-chain-verified final game state**, inside a single `settle()`. No new trust and no extra
settlement transaction per market.

- **Faction — "Which faction wins?"** (`TOWN` / `MAFIA`). The headline market, opened first at match
  start. A mistrial Voids it.
- **Night kill — "Who dies tonight?"** *(recurring, per round).* Over the living seats plus a "no one /
  all spared" outcome. Round 1 opens with the match; the host floats a fresh one each night and freezes
  it at dawn.
- **Voted out — "Who hangs this round?"** *(recurring, per round).* Over the living seats plus a
  "no one" outcome (a tie / no elimination). Round 1 opens with the match; a fresh one floats each day
  and freezes once that vote resolves. Only the currently-bettable round shows live; resolved rounds
  drop to History.
- **Who is the Mafia?** *(on-demand).* One outcome per seat.
- **Detective claim — "real, or a bluff?"** *(on-demand, per claiming seat).* Fires when a player
  claims the Detective role.
- **Mechanism:** parimutuel pools with one pool per outcome. Backers of the resolved (winning) outcome
  split the pot pro-rata, minus a small protocol fee — always solvent regardless of bet skew. If nobody
  backed the winning outcome, the market **Voids** and every stake is refunded.
- **Currency:** wagers are placed in **CHIP**, a faucet-mintable mock ERC20 (`MockBetToken`) — test
  money with no value. Tap **"Get test tokens"** in the UI to mint some.
- **Gasless by default (EIP-2771):** when the host runs a funded relayer, a spectator with **zero
  native 0G** can play — the wallet signs each action off-chain and a backend relayer submits it through
  a trusted `Forwarder` and pays the gas, while the user stays the on-chain bettor. It's the default
  whenever the relayer is live and funded (a "⛽ Gasless" toggle opts out); otherwise the UI falls back
  to the normal path where gas is paid in native 0G. Real on-chain mechanism, not a mock.
- **Pop-up-free betting:** an in-browser **session key** (derived from one signature) or a **guest
  burner** key is the on-chain bettor and signs relayed requests locally — no wallet pop-up per wager.
- **Batch claim:** one tap collects every winning/refund for a match in a single transfer.
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
| `frontend/`  | Live arena UI, betting panel, session/guest wallets, batch claim, CHIP faucet | Live Arena (UI)     |

---

## On-chain (0G Galileo testnet, chainId `16602`)

| Contract                | Address                                      |
| ----------------------- | -------------------------------------------- |
| `MafiaMarket`           | `0x0f179Da6a8133F8fdD5A33ebd18e5Ff3C3fD341f` |
| `MockBetToken` (CHIP)   | `0x48cF05921C8f042Ed337f56F947542aB89691aBb` |
| `Forwarder` (EIP-2771)  | `0xaD341c0A01eaA8EBe8B9aee9FD1364C619fB770A` |

RPC `https://evmrpc-testnet.0g.ai` · Explorer https://chainscan-galileo.0g.ai · Faucet
https://faucet.0g.ai (native 0G for gas; CHIP comes from the in-app faucet). `MafiaMarket` is a
multi-match factory: each match's Faction, recurring per-round Night-kill / Voted-out, and on-demand
Who-is-the-Mafia / Detective-claim markets are all categorical props on this one contract.

**Inference, though, runs on 0G mainnet** (Aristotle, chainId `16661`, RPC `https://evmrpc.0g.ai`) on
`qwen3.6-plus` — the one component that touches **real mainnet 0G** (settled in batches; per-inference
cost is tiny). Everything above — market, CHIP, settlement, storage — stays on free Galileo testnet.

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
revert settlement. Player inference runs on **0G mainnet** (`qwen3.6-plus`); the market, CHIP,
settlement, and storage stay on **Galileo testnet**. The mainnet provider's signed metadata still
reports `provider_type: centralized, identity: aliyun` with an RA-TLS certificate fingerprint: per 0G's
mainnet TeeML a dstack/Intel-TDX serving enclave captures the exact req/res bytes and signs the
envelope we `ecrecover` — so the operator cannot forge, replay, or re-order a move — but the model
itself runs on a centralized upstream, not end-to-end in-enclave, and we verify the signature on-chain,
not the TDX attestation. The cryptographic verification path is production-grade; full in-enclave model
inference is the remaining gap, not a design flaw.
