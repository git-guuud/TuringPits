# My Tasks (human, out-of-code)

Setup that must be done outside of coding. Each open item blocks the listed work until done.
Drop values into a local `.env` (gitignored).

> **Confirmed 0G integration facts** (TEE attestation format, Compute access, network) have
> moved to `STATUS.md` → "0G integration — confirmed facts". This file now tracks only the
> setup still owed by a human.

## ✅ Resolved — no action needed
- **§A — TEE attestation format.** Confirmed live: EIP-191/ECDSA signature `ecrecover`s to the
  provider's `teeSignerAddress` `0x83df…08cF`. Format + Day-5 verifier impact in `STATUS.md`.
- **§B — 0G Compute access.** Provisioned and live-confirmed: Router `sk-` key **and** a funded
  Direct-SDK wallet (`COMPUTE_PRIVATE_KEY`), model `qwen2.5-omni`. All set in `.env`.
- **§C — 0G Storage access.** Public testnet endpoints, no key/provisioning needed and set in
  `.env`: indexer `https://indexer-storage-testnet-turbo.0g.ai` (turbo, recommended), RPC
  `https://evmrpc-testnet.0g.ai`. Day-4 uploads are paid from the already-funded
  `COMPUTE_PRIVATE_KEY` wallet.

## §D — Blocks Day 5 (contract deploy on 0G Chain) — OPEN
0G Galileo Testnet — chainId **16602**, RPC `https://evmrpc-testnet.0g.ai`,
faucet `https://faucet.0g.ai` (free testnet 0G; daily drip is small — claim early).

- [x] Deployer wallet — **reusing the Compute wallet** (`DEPLOYER_PRIVATE_KEY` = the same key
      as `COMPUTE_PRIVATE_KEY`; all on one chain).
- [ ] **Keep the wallet faucet-funded** — gas for deploys + a few txns, on top of what the
      Compute Direct-SDK ledger already locked (~1 0G). Claim across a couple of days if the
      drip is small.

> Reference: https://docs.0g.ai/llms.txt
> Settlement trusts the registered TEE signer key (§A) — there is no separate oracle key.
