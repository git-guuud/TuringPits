# My Tasks (human, out-of-code)

Setup that must be done outside of coding. Each item blocks the listed day until done.
Check items off as you complete them and drop the values into a local `.env` (gitignored).

## Blocks Day 3 (0G Storage) and Day 4 (contract deploy)
- [ ] Create a 0G testnet wallet; export the deployer private key →
      `DEPLOYER_PRIVATE_KEY` (keep in `.env`, never commit).
- [ ] Fund the wallet from the 0G testnet faucet (enough for deploys + a few txns).
- [ ] Get the 0G Chain testnet RPC URL → `ZEROG_RPC_URL`.
- [ ] Confirm the 0G testnet chainId (for `hardhat.config.ts`).

## Blocks Day 3 (0G Storage)
- [ ] 0G Storage endpoint / indexer URL + any access key the SDK needs →
      `ZEROG_STORAGE_*` env vars.

## Blocks Day 5 (0G Compute)
- [ ] 0G Compute access (account / API or node access) and confirm how a job is
      submitted and how results/signatures come back.
- [ ] Decide the oracle signing key the contract's `settle()` will trust →
      `ORACLE_PRIVATE_KEY` (and publish the matching public key/address on-chain).

> Reference: https://docs.0g.ai/llms.txt
> Tell me here if any of these turn out to be unavailable so we can plan a labeled mock.
