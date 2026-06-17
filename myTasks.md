# My Tasks (human, out-of-code)

Setup that must be done outside of coding. Each item blocks the listed work until done.
Check items off as you complete them and drop the values into a local `.env` (gitignored).

## §A. Blocks Day 5 (on-chain verifier) — HIGHEST PRIORITY
The entire fully-on-chain settlement design depends on this.

**RESOLVED FROM 0G DOCS (2026-06-17)** — see "Findings" below. Net: `ecrecover` works, but
the TEE signs the **response text**, not our compact structured-decision payload. This
changes the Day-3 / Day-5 plan; details under Findings §A.

- [x] **TEE attestation signature scheme** — **EIP-191 `personal_sign`** (Ethereum
      secp256k1/ECDSA). Solidity `ecrecover` works **as long as we re-apply the EIP-191
      prefix** (`\x19Ethereum Signed Message:\n<len>` + text) before hashing. ✅
- [x] **Exactly what bytes the TEE signs** — the **model response *text*** (the output
      string), **not** our `{nonce,phase,round,player,action,target}` payload. Fetched via
      `GET {providerUrl}/v1/proxy/signature/{chatID}?model={model}` → `{text, signature}`.
      ⚠️ **Design impact:** the contract must reconstruct the exact signed *text* bytes to
      verify. To keep on-chain reconstruction small/cheap, the **decision** should be its
      own constrained inference whose *entire* output IS the canonical decision string
      (separate from the free-form speech call). Otherwise take the §6 fallback (verify the
      sig over the text on-chain, parse the decision off-chain, label `// MOCK:`).
- [x] **How the provider key/address is published** — the provider's **`teeSignerAddress`**
      is read from the **on-chain service record** for that provider; the inference call
      also returns the provider address in `x_0g_trace.provider` (e.g.
      `0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C`). Register this as `TEE_PROVIDER_ADDRESS`.

> **Still requires a human / live check:** pin the *exact* provider + `teeSignerAddress`
> we'll use (depends on which model/provider we pick in §B), and confirm the on-chain
> lookup path for `teeSignerAddress` once we have an account.

### ⚡ LIVE CONFIRMATION (2026-06-17) — real calls against the testnet router
Verified by `players/scripts/live-turn.mjs` against `qwen2.5-omni` (provider `0xa48f…7836`):
- ✅ **Inference is genuinely TEE-attested.** `verify_tee:true` → `x_0g_trace.tee_verified:true`,
  `x_0g_trace.provider` + `x-provider` header = `0xa48f01287233509FD694a22Bf840225062E67836`
  (= our `TEE_PROVIDER_ADDRESS`). `x_0g_trace.billing` gives per-call cost.
- ✅ **chatID = the `zg-res-key` response header** (a UUID), NOT `body.id` (`chatcmpl-…`).
- ✅ **Model emits canonical decisions reliably** — `qwen2.5-omni` returned a byte-exact
  canonical decision string that `parseDecision` accepted first try (the §3 two-layer design
  holds against the real model).
- 🚧 **BLOCKER for on-chain settlement — no raw signature from this router.** The configured
  router (`router-api-testnet.integratenetwork.work`) exposes only `/v1/chat/completions` and
  `/v1/models`; **every `/v1/proxy/signature/{chatID}` shape 404s.** So it returns a
  `tee_verified` *boolean* but NOT the `{text, signature}` our Solidity `ecrecover` needs.
  → Raw signatures require the **Direct SDK** path (`@0gfoundation/0g-compute-ts-sdk`,
  `broker.inference.processResponse(provider, chatID)`) against the provider's own service
  URL — which needs a **funded wallet (`COMPUTE_PRIVATE_KEY`)**, not the `sk-` router key.
  **Day-3 task:** stand up the Direct broker, fetch a real `{text, signature}`, and confirm it
  `ecrecover`s to the registered signer. If the Direct sig can't land, Day 5 takes the §6
  fallback (trust the router's `tee_verified`, labeled `// MOCK:`/downgraded).

## §B. Blocks Day 2–3 (0G Compute TEE players)

**RESOLVED FROM 0G DOCS (2026-06-17)** — both integration paths confirmed; see Findings §B.
What's left is account setup + funds (human-only).

- [x] **Router vs Direct decided by docs:**
      - **Router** (OpenAI-compatible, server-side): base URL `https://router-api.0g.ai/v1`,
        `Authorization: Bearer sk-...`. Simplest for the Sequencer.
      - **Direct** (SDK + wallet): `createZGComputeNetworkBroker(wallet)`, `PRIVATE_KEY` env,
        per-provider sub-accounts. Gives `broker.inference.processResponse()` verification.
- [x] **TEE attestation return path confirmed:**
      - Router: add `"verify_tee": true` to the request body → result in
        `x_0g_trace.tee_verified` (`true`/`false`/absent) + `x_0g_trace.provider`. Raw
        `{text, signature}` via `GET /v1/proxy/signature/{chatID}`.
      - Direct: `processResponse(providerAddress, chatID)` (chatID from `ZG-Res-Key`
        header) verifies the provider's TEE signature.
- [ ] **HUMAN: create a 0G Compute account + key.** Go to **pc.0g.ai** → connect wallet →
      deposit 0G tokens → Dashboard → API Keys → create an `inference`-permission key
      (`sk-...`). Put it in `.env` as `ZEROG_COMPUTE_API_KEY` (and `ZEROG_COMPUTE_BASE_URL=
      https://router-api.0g.ai/v1`). If we go Direct instead, fund a wallet (~3 0G ledger +
      ≥1 0G/provider) and set `COMPUTE_PRIVATE_KEY` (see `.env.example`).
- [x] **Player model = `qwen2.5-omni`** (the only TEE chat model on testnet; the other,
      `qwen/qwen-image-edit-2511`, is image-only). Confirmed TEE-verifiable live
      (`tee_verified:true`, provider `0xa48f…7836`). Recorded as `ZEROG_COMPUTE_MODEL`.

> **Testnet funding (confirmed 2026-06-17):** Compute runs on **0G Galileo Testnet** (see
> §D for chainId/RPC/faucet) — fund with **free faucet 0G**, no real money. The **Direct**
> SDK path is the one the docs clearly show on testnet (broker wallet on `ZEROG_RPC_URL`,
> faucet-funded deposit) and gives `processResponse()` verification. The **Router**
> (`pc.0g.ai`) deposit-with-faucet-tokens path is **not definitively documented** — if it
> balks, pivot to Direct (our `InferenceProvider` interface already supports both).

> **Direct SDK package (confirmed against npm 2026-06-17):**
> **`@0gfoundation/0g-compute-ts-sdk`** (latest `0.8.4`, exports
> `createZGComputeNetworkBroker`). The older `@0glabs/0g-serving-broker` (`0.7.8`) is
> **deprecated** — npm message: *"Package renamed to @0gfoundation/0g-compute-ts-sdk."*
> Do not install the `@0glabs` one.

## §C. Blocks Day 4 (0G Storage)
- [ ] 0G Storage endpoint / indexer URL + any access key the SDK needs →
      `ZEROG_STORAGE_*` env vars.

## §D. Blocks Day 5 (contract deploy on 0G Chain)

**Network confirmed from docs (`docs.0g.ai/llms-full.txt`, 2026-06-17): 0G Galileo Testnet.**
Everything (Compute §B + Chain §D) runs here on free faucet tokens — no real funds.

| Field | Value |
|---|---|
| Network name | **0G Galileo Testnet** |
| Chain ID | **16602** (`ZEROG_CHAIN_ID`) |
| RPC URL | **`https://evmrpc-testnet.0g.ai`** (`ZEROG_RPC_URL`) |
| Faucet | **`https://faucet.0g.ai`** (free testnet 0G; docs cite ~0.1 0G/day — verify drip size when claiming) |

- [ ] Create a 0G testnet wallet; export the deployer private key →
      `DEPLOYER_PRIVATE_KEY` (keep in `.env`, never commit).
- [ ] Fund the wallet from the faucet above (enough for deploys + a few txns). ⚠️ If the
      daily drip is as small as the docs suggest, claim across a couple of days early.
- [x] 0G Chain testnet RPC URL → `https://evmrpc-testnet.0g.ai` (above).
- [x] 0G testnet chainId → **16602** (for `hardhat.config.ts`).

> Reference: https://docs.0g.ai/llms.txt
> Tell me here if any of these turn out to be unavailable so we can plan a labeled mock.
> Note: there is **no separate oracle signing key** anymore — settlement is on-chain and
> trusts the registered TEE provider key from §A, not a custom oracle.

---

## Findings — 0G docs review (2026-06-17)
Source pages (under `https://docs.0g.ai/.../compute-network/`):
`router/features/verifiable-execution`, `inference`, `router/comparison`,
`router/authentication`, `router/quickstart`.

### §A — TEE attestation (verifiable execution)
- **Scheme:** EIP-191 `personal_sign` (Ethereum secp256k1/ECDSA). Docs: *"Any standard
  Ethereum library works"* for verification. → `ecrecover`-compatible with the EIP-191
  prefix.
- **Signed content:** the model **response text**. Independent verification flow per docs:
  1. fetch the provider's `teeSignerAddress` from on-chain service records;
  2. `GET {url}/v1/proxy/signature/{chatID}?model={model}` → `{text, signature}`;
  3. verify `signature` as EIP-191 over `text` against `teeSignerAddress`;
  4. confirm `text` matches the response you received.
- **Router shortcut:** `"verify_tee": true` in the body; the Router reports
  `x_0g_trace.tee_verified` + `x_0g_trace.provider`.
- **Implication for our contract:** signed bytes = response text, so the on-chain verifier
  must hash the *exact text* (EIP-191-prefixed) and `ecrecover`. Keep that text tiny &
  canonical (decision-only inference) or use the §6 labeled fallback.

### §B — Compute access
- **Router:** base URL `https://router-api.0g.ai/v1`, OpenAI-compatible
  `/v1/chat/completions`, `Authorization: Bearer sk-...`. Keys + deposits at **pc.0g.ai**.
  Server-side only (keys are secret).
- **Direct:** `import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk"`
  (npm-confirmed, v0.8.4), `broker.inference.getServiceMetadata/getRequestHeaders`, verify with
  `broker.inference.processResponse(providerAddress, chatID)`. Wallet + 0G funds required.
- **Comparison:** Router = API key, batched settlement, backend-only. Direct = wallet signs
  each call, per-provider sub-accounts, browser-safe. For our server-side Sequencer that
  needs on-chain-verifiable attestations, **Router + `verify_tee`** is the simplest start;
  Direct is the fallback if we need per-call sub-account settlement.
