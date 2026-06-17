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
- [x] **Exactly what bytes the TEE signs** — ⚠️ **SUPERSEDED by the live run below.** The
      docs implied "the model response text"; the *actual* signed payload is a colon-joined
      **envelope** `sha256(request):sha256(response):provider_type:provider_identity:tls_fingerprint`,
      NOT the raw text and NOT our decision payload. See "LIVE DIRECT-SDK SIGNATURE" below for
      the confirmed format and its on-chain-verifier impact.
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

### ✅ LIVE DIRECT-SDK SIGNATURE (2026-06-17) — `players/scripts/live-direct.mjs`
Direct SDK end-to-end against provider `0xa48f…7836` / model `qwen/qwen2.5-omni-7b`. **Raw
signature obtained and on-chain-style verification CONFIRMED.** This de-risks the Day-5 verifier.

- ✅ **`ecrecover` works.** Signature (`signing_algo: ecdsa`, EIP-191) recovers to
  **`0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF`** = the on-chain `teeSignerAddress` from
  `broker.inference.checkProviderSignerStatus(provider)`. ⇒ Solidity `ecrecover` is viable.
- ⚠️ **TWO addresses — don't confuse them.** The **provider account** `0xa48f…7836` addresses
  the service in SDK calls; the **TEE signer** `0x83df…08cF` is what the signature recovers to
  and what the **contract must register / `ecrecover` against**. (Earlier we wrongly assumed
  `TEE_PROVIDER_ADDRESS` = the ecrecover target; it's the *provider*, not the *signer*.)
- ✅ **Confirmed signed-bytes format.** `text` =
  `<reqHash>:<resHash>:<provider_type>:<provider_identity>:<tls_cert_fingerprint>`, all colon-joined,
  EIP-191-signed. Verified live: **`resHash` (part[1]) = `sha256(raw response body)`** (matched,
  and tracked the response across runs). `reqHash` (part[0]) = `sha256(request)` in the
  provider's own serialization (constant across identical requests; not reproducible from a
  naive body re-serialization — treat as opaque). Example:
  `f4c1aa68…:d05130b9…:centralized:aliyun:9e621feb…`.
- 🔧 **On-chain verifier (Day 5) design — UPDATED from this:** the sig binds the **response
  hash**, not the literal decision text. So `settle()` per decision:
  1. take the full **response body** + `reqHash` + `provider_type` + `provider_identity` +
     `tls_cert_fingerprint` + `signature` as calldata;
  2. recompute `sha256(responseBody)` on-chain (SHA-256 precompile) ⇒ must equal part[1];
  3. rebuild the envelope string, EIP-191-hash, `ecrecover` ⇒ must equal registered signer;
  4. parse the canonical decision out of `responseBody` and check it against moderator rules.
  Heavier than "hash the decision string" (full response in calldata + sha256/decision), but
  tractable for ~20–40 decisions. The §3 "decision-only inference" still helps by keeping the
  response body tiny. (`encodeDecision` is no longer the signed-bytes target — re-scope Day-5.)
- ⚠️ **TRUST CAVEAT — flagged honestly.** The signed metadata says **`provider_type:
  "centralized", provider_identity: "aliyun"`** with a TLS cert fingerprint — i.e. this testnet
  provider attests via a **centralized signer + RA-TLS**, not (visibly) hardware Intel-TDX,
  even though the router reports `tee_verified:true` (dstack). The *mechanism* we build on
  (provider-signed, on-chain-`ecrecover`able attestation) is fully real; the **strength** of
  the underlying execution guarantee on this testnet provider is weaker than "hardware TEE."
  Note this in the demo's trust story rather than overclaiming "hardware TEE."
- 💰 **Cost:** ledger created with **3 0G** (SDK minimum), **1 0G** auto-locked to the provider
  sub-account; per-inference fee ~1.6e13 wei (negligible). A full ~40-decision match fits easily.
- 🔧 **Register for Day-5 / `.env`:** `TEE_SIGNER_ADDRESS=0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF`
  (ecrecover target), distinct from `TEE_PROVIDER_ADDRESS=0xa48f…7836` (SDK provider id).

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

### 🚧 LIVE DIRECT-SDK RUN (2026-06-17) — `players/scripts/live-direct.mjs`
Broker wires up correctly: `createZGComputeNetworkBroker(wallet)` detects testnet (chain
16602), reaches ledger creation. **Blocked on funds, not code:**
- [ ] **HUMAN: fund `COMPUTE_PRIVATE_KEY` wallet with ≥ ~3.1 0G.** The SDK enforces a hard
      **3 0G minimum** to create the Direct ledger (`broker.ledger.addLedger(3)`), + gas.
      Wallet `0xCDa8102a5eD9cbF154295D2ef62ea4AFFF47F134` currently holds **0.6 0G** — short.
      ⚠️ The web faucet drip is small; reaching 3 0G likely needs the **0G Discord faucet** or
      repeated/larger claims. Once funded, re-run the script — steps 3–8 fetch the raw
      `{text, signature}` via `getChatSignatureDownloadLink` and `ecrecover` it (the on-chain
      path). This is the LAST gate before the Day-5 verifier is provably viable.
- [ ] **FIX `.env`:** `ZEROG_RPC_URL` is set to `https://pc.testnet.0g.ai` (the **portal**) —
      the broker needs the **EVM RPC `https://evmrpc-testnet.0g.ai`**. The script hardcodes the
      correct RPC for now; update `.env` so the real provider class uses it.

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
