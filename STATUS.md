# Status

_Updated: 2026-06-22_

## Current task
**AI Mafia** (multiple LLMs playing Mafia). Days 1–5 **complete** (engine, TEE players,
commit-reveal, 0G Storage, deployed on-chain verifier/market — see `TODO.md`). **Live 0G-TEE
provider now wired in and confirmed:** the `players/` `Attestation` evolved to the live
envelope model (`sha256(req):sha256(res):type:identity:tls_fp`) that `TeeEnvelope.sol`
verifies; `ZeroGDirectProvider` (Direct SDK) replaced the broken Router path and passed a live
inference; and a cross-layer Hardhat test settles a real `playMatch` transcript on the deployed
contract. **Next: Day 6 (frontend live arena + betting UI).** Design:
`docs/superpowers/specs/2026-06-17-ai-mafia-design.md`.

## Done
- [x] Monorepo scaffolded (npm workspaces): `engine`, `contracts`, `storage`,
      `server`, `frontend` — each with package manifest, tsconfig, stub source, README.
      (`oracle` removed — settlement is on-chain.)
- [x] **Day 1 — Moderator engine + structured decisions.** `engine/` is the deterministic
      Mafia moderator: `assignRoles` (seeded Fisher–Yates), `initState`, `applyDecision`
      (validates + throws on illegal/out-of-order), `winner`, `runMatch`, and
      `encodeDecision` (canonical-JSON signed bytes). Roles MAFIA/DOCTOR/DETECTIVE/TOWN,
      night/day sequencing, doctor save, detective record, plurality tallies (tie → no-op),
      parity/elimination win detection. Pure, zero non-deterministic inputs. 22 vitest
      tests green (determinism, scripted MAFIA/TOWN matches, all illegal-move classes).
      Design: `docs/superpowers/specs/2026-06-17-moderator-engine-design.md`.
- [x] Root tooling: `package.json` workspaces, `tsconfig.base.json`, `.gitignore`,
      `README.md`.
- [x] **Verified 0G capabilities** against the docs: Compute is AI-inference/fine-tuning
      only (cannot run arbitrary code) → original "Compute re-runs the match" path dropped.
- [x] **Game decided: LLM Mafia.** Trust anchor = TEE-attested inference; settlement =
      fully on-chain (verify TEE sigs + Mafia rules in Solidity). Faction-win market for MVP.
- [x] Design spec written and approved.

- [x] **Day 2 — `players/` abstraction over 0G Compute TEE inference.** New `players/`
      workspace. One `InferenceProvider` interface (BYOM-ready: each seat holds its own
      provider). `Player.takeTurn` produces the two-layer turn — free-form `speech` + a
      constrained decision inference whose *entire* output IS the canonical decision string
      (`encodeDecision`), so the attestation binds the exact bytes the contract reconstructs
      (`myTasks.md §A`). `verifyAttestation` is the real, reusable EIP-191 `ecrecover` check
      the Day-5 contract mirrors. `playMatch` drives the Day-1 moderator with real player
      calls and captures the attested transcript. 25 vitest tests green: a full match runs
      end-to-end, every decision attestation verifies locally, the captured decisions replay
      through the pure moderator to the same winner, and parse rejects illegal/non-canonical
      output. (Historical: a Router-based `ZeroGComputeProvider` was written here; it was later
      removed when the testnet Router proved to expose no signature endpoint — the real path is
      now the Direct-SDK `ZeroGDirectProvider`. See "Mocks / stubs in place".)

- [x] **Day 3 — role-assignment commit-reveal + confirmed TEE attestation format.**
      `engine/src/commit.ts`: `commitRoles`/`verifyRoleReveal`/`generateSalt`/
      `roleCommitPreimage`. Commit = `sha256(abi.encodePacked(uint8[] roles, bytes32 salt))`
      (role enums MAFIA=0/DOCTOR=1/DETECTIVE=2/TOWN=3, packed in seat order, then the 32-byte
      salt) — reconstructed on-chain by the SHA-256 precompile the §A verifier already uses,
      so no new on-chain primitive. The server commits before betting and reveals only
      `(roles, salt)` at settlement; the secret seed is never disclosed. `verifyRoleReveal`
      never throws (gates settlement on a boolean, like `verifyAttestation`). 11 vitest tests:
      accepts the true reveal, rejects a tampered role / wrong salt / reordered assignment,
      returns false on malformed salt, and round-trips a seeded `assignRoles`. Engine now 33
      tests green. TEE attestation format was already **confirmed live** (see "0G integration
      — confirmed facts" below) — no engine change needed; the signed-bytes target is the
      response envelope, not `encodeDecision`, which re-scopes the Day-5 verifier.

- [x] **Day 5 — On-chain Mafia verifier + betting market deployed to 0G Galileo testnet.**
      `contracts/` rewritten: `MafiaMarket.sol` (parimutuel YES/NO faction-win escrow +
      `settle()` orchestration) + three pure libraries — `DecisionCodec` (reconstructs the
      engine's canonical decision JSON on-chain, byte-for-byte, + JSON-escape), `TeeEnvelope`
      (rebuilds the real 0G-TEE envelope `sha256(req):sha256(res):type:identity:tls_fp` and
      `ecrecover`s the signer via the SHA-256 precompile + EIP-191), and `MafiaRules` (a faithful
      Solidity port of the `engine/` moderator: night/day sequencing, doctor save, detective
      check, plurality votes, parity/elimination win). `settle()` verifies each move's TEE
      envelope, binds the typed decision to the signed response body by an offset/slice check,
      checks the commit-reveal role assignment (SHA-256, one byte per role + salt — matches
      `engine/src/commit.ts`), runs the state machine, and pays the winner. **16 Hardhat tests
      green** (codec cross-checked vs the engine, envelope recover, state-machine winner == engine
      winner via dynamic import, full market lifecycle, and the cheat path: forged/dropped/tampered
      move + bad reveal + settle-before-lock + double-claim all revert). **Deployed:**
      `0xd4d1007585f9bAa44DaBbBCb224a09395F41ca5F` on 0G Galileo (chainId 16602; bytecode verified
      on-chain). The on-chain verification *mechanism* is real; the test signer is a labeled local
      key. Wiring the live 0G-TEE provider into a real match for end-to-end settlement is Day 6/7
      follow-up.
  - **Known limitations (deferred past MVP, not soundness issues — a rigged game still cannot
    settle):** (1) if the on-chain-computed winner's side received zero bets, the losing pool is
    trapped (no refund/void path yet); (2) no settlement timeout — if the host never calls
    `settle()`, bettor funds have no reclaim path. Both are bettor-protection/liveness features
    for a production market; the demo host is trusted. Also deferred to Day 6: event emissions
    (`MarketOpened`/`BetPlaced`/`BettingLocked`/`Settled`/`Claimed`) for the frontend to index.

- [x] **Day 4 — 0G Storage evidence layer.** `storage/` is now real
      (`@0gfoundation/0g-storage-ts-sdk` v1.2.10). `serializePersonas` / `serializeMatch`
      produce **canonical** bytes (recursively sorted keys, compact) so identical evidence
      always yields the same root — content-addressed and auditable. `root(bytes)` derives the
      0G merkle root locally (offline). `createZeroGStorage({indexerUrl, rpcUrl, privateKey})`
      uploads via in-memory `MemData` (no temp files, `skipIfFinalized`) and downloads via
      `downloadToBlob` with merkle-proof verification; the library reads no globals (caller
      passes `.env`). **Live-confirmed on Galileo testnet** (`storage/src/live.test.ts`,
      `RUN_LIVE_STORAGE=1`): persona + transcript uploaded, downloaded by root, announced root
      == locally-derived root, `sha256(download) == sha256(upload)` for both (e.g. transcript
      root `0xe1a632bab279fbf71d71ca83d2b1908310c4b0905190635097e1db885c02a1da`). Offline
      suite (serialization + SDK root, 12 tests) stays green with no network/funds; live test
      skipped by default. Uploads paid by the funded `COMPUTE_PRIVATE_KEY` wallet.

## In progress
- (none — live-TEE provider wiring complete; next is Day 6.)

## Pending
- Days 6–7 per `TODO.md`.

## 0G integration — confirmed facts (live, 2026-06-17)
Durable findings from real testnet calls (`players/scripts/live-turn.mjs`,
`live-direct.mjs`). Credentials live in `.env`; remaining human setup in `myTasks.md` (§C, §D).

- **Network — 0G Galileo Testnet:** chainId **16602**, EVM RPC `https://evmrpc-testnet.0g.ai`,
  faucet `https://faucet.0g.ai`. All free testnet 0G, no real funds.
- **TEE attestation is `ecrecover`-viable.** EIP-191/ECDSA. The signature recovers to the
  provider's **`teeSignerAddress` `0x83df…08cF`** (from `checkProviderSignerStatus`) — distinct
  from the **provider account `0xa48f…7836`** (used to address the service in SDK calls). The
  contract registers/checks the **signer**, not the provider.
- **Signed bytes are an envelope, NOT our decision text:**
  `sha256(req):sha256(res):provider_type:provider_identity:tls_fingerprint`, colon-joined,
  EIP-191-signed. `part[1] = sha256(raw response body)` (confirmed); `part[0] = sha256(request)`
  is opaque (provider's own serialization). ⇒ Day-5 `settle()` takes the full response body +
  envelope fields + signature as calldata, recomputes `sha256(body)` (precompile 0x2), rebuilds
  the envelope, EIP-191-hashes, `ecrecover`s vs the registered signer, then parses the decision
  out of the body. **`encodeDecision` is therefore not the signed-bytes target.**
- **Compute access — both paths provisioned & working:** Router (OpenAI-compatible, `sk-` key,
  returns a `tee_verified` boolean only) and **Direct SDK** (`@0gfoundation/0g-compute-ts-sdk`
  v0.8.4, funded wallet, returns the raw `{text, signature}` the verifier needs). Direct ledger
  needs a **3 0G** minimum; per-inference fee negligible (~1.6e13 wei).
- **Player model `qwen2.5-omni`** — the only TEE chat model on testnet; live-confirmed
  `tee_verified:true` and emits byte-exact canonical decision strings `parseDecision` accepts.
- **⚠️ Trust caveat (state honestly in the demo):** the testnet provider's signed metadata is
  `provider_type:"centralized", provider_identity:"aliyun"` + TLS-cert fingerprint (RA-TLS),
  not visibly hardware Intel-TDX. The attestation *mechanism* (provider-signed,
  on-chain-`ecrecover`able) is fully real; the execution guarantee is weaker than "hardware TEE."

## Mocks / stubs in place
- `engine/`, `players/`, `storage/`, and `contracts/` are real (no mocks). `storage`
  upload/download/round-trip is live-confirmed on testnet (Day 4). `server`/`frontend` are
  still no-op stubs (Day 6).
- **The real `players/` ↔ `contracts` wiring is done and proven offline.** The `players/`
  `Attestation` now carries the live-confirmed 0G-TEE **envelope**
  (`reqHash:sha256(body):type:identity:tls`, see confirmed facts) that `TeeEnvelope.sol`
  verifies; `verifyAttestation` mirrors the Solidity recover, and `toSettlementMove` maps an
  attested turn straight to `MafiaMarket.settle()` calldata. A cross-layer Hardhat test
  (`contracts/test/PlayersIntegration.test.ts`) runs a full `playMatch` and **settles its
  transcript on the deployed contract to the engine-declared winner**.
- **The real provider is `ZeroGDirectProvider` (`zerog.ts`, Direct SDK) — live-confirmed.**
  It is the production path (NOT a mock); the broken Router-signature `ZeroGComputeProvider`
  was removed. The flag-gated live test (`players/src/live.test.ts`, `RUN_LIVE_COMPUTE=1`)
  **passed against real 0G Compute on Galileo (2026-06-22):** one TEE inference returned a
  `"0g-tee"` envelope that `verifyAttestation` accepts and that recovers the registered
  `teeSignerAddress` `0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF`. Paid from the funded
  `COMPUTE_PRIVATE_KEY`.
- **`MockLocalProvider` (`# MOCK:` in `provider.ts`)** remains for offline/CI. It produces the
  SAME envelope shape — real ECDSA/EIP-191 signatures, genuinely verified — differing only in
  the signer: a **local test key, not a 0G TEE provider** (`source` = `"MOCK-local"`, never
  mistaken for a real attestation). No attestation is faked silently.

## Known scope risk
- Day 5's **on-chain Mafia state machine + TEE-signature verification** (the heaviest piece)
  **landed in full** — the labeled fallback (verify sigs + commit-reveal on-chain, trust the
  tally) was NOT needed. The verifier reconstructs the response envelope (full body in calldata
  + SHA-256 precompile + `ecrecover`); 16 Hardhat tests green and deployed to Galileo.
- Remaining risk is now **Day 6 (frontend) breadth** and the **live-TEE end-to-end run**: the
  player layer is being aligned to the contract's envelope model (in progress), after which a
  real `qwen2.5-omni` match must be captured and settled on-chain at least once for the demo.
