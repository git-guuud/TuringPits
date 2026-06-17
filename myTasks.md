# My Tasks (human, out-of-code)

Setup that must be done outside of coding. Each item blocks the listed work until done.
Check items off as you complete them and drop the values into a local `.env` (gitignored).

## §A. Blocks Day 5 (on-chain verifier) — HIGHEST PRIORITY
The entire fully-on-chain settlement design depends on this. Confirm from the 0G docs /
team / Discord:
- [ ] **TEE attestation signature scheme** — is it secp256k1/ECDSA? (Solidity `ecrecover`
      only works for ECDSA.) If not, the on-chain verifier needs a different approach.
- [ ] **Exactly what bytes the TEE signs** — the structured-decision payload, or a full
      request/response envelope? We must be able to reconstruct that signed hash on-chain.
- [ ] **How the provider public key / address is published** so the contract can register
      and trust it → `TEE_PROVIDER_ADDRESS`.

## §B. Blocks Day 2–3 (0G Compute TEE players)
- [ ] 0G Compute access — provider/model availability, router vs direct path, and the
      API key / wallet needed to make TEE inference calls → `ZEROG_COMPUTE_*` env vars.
- [ ] Confirm how the TEE attestation is returned alongside each inference response.

## §C. Blocks Day 4 (0G Storage)
- [ ] 0G Storage endpoint / indexer URL + any access key the SDK needs →
      `ZEROG_STORAGE_*` env vars.

## §D. Blocks Day 5 (contract deploy on 0G Chain)
- [ ] Create a 0G testnet wallet; export the deployer private key →
      `DEPLOYER_PRIVATE_KEY` (keep in `.env`, never commit).
- [ ] Fund the wallet from the 0G testnet faucet (enough for deploys + a few txns).
- [ ] Get the 0G Chain testnet RPC URL → `ZEROG_RPC_URL`.
- [ ] Confirm the 0G testnet chainId (for `hardhat.config.ts`).

> Reference: https://docs.0g.ai/llms.txt
> Tell me here if any of these turn out to be unavailable so we can plan a labeled mock.
> Note: there is **no separate oracle signing key** anymore — settlement is on-chain and
> trusts the registered TEE provider key from §A, not a custom oracle.
