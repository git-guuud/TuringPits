# Status

_Updated: 2026-07-06_

> **Live on 0G Galileo (chainId 16602).** The full "Proof of Battle" demo loop —
> **watch** a live LLM Mafia match → **predict** in CHIP → **on-chain settle** → **claim** — runs
> end-to-end. Deployed and current (verified on-chain against the source):
>
> | Contract | Address |
> |---|---|
> | `MafiaMarket` (multi-match factory) | `0x0f179Da6a8133F8fdD5A33ebd18e5Ff3C3fD341f` |
> | `MockBetToken` (CHIP, the mock currency) | `0x48cF05921C8f042Ed337f56F947542aB89691aBb` |
> | `Forwarder` (EIP-2771 gasless) | `0xaD341c0A01eaA8EBe8B9aee9FD1364C619fB770A` |
>
> Every market is a **categorical parimutuel prop**, all resolved inside one TEE-verified `settle()`:
> the headline **Faction** (which faction wins), recurring per-round **Voted out** / **Night kill**,
> and on-demand **Who is the Mafia** and **Detective claim (real / bluff)**. Predictions are in **CHIP**
> (faucet-mintable mock ERC20), **gasless by default** through the funded relayer, signed pop-up-free
> by an in-browser **session / guest wallet**, and **open until settlement**.
>
> **All suites green:** contracts **128** (Hardhat), engine **37**, players **226** (+1 live-skip),
> storage **12** (+2 live-skip), server **80**; frontend type-check + `vite build` clean. There is
> **no pending redeploy** — the deployed bytecode matches the current source.

## What's live right now

- **The demo loop runs end-to-end.** A real `qwen3.6-plus` match — **inference on 0G mainnet**
  (chainId 16661), **market + settlement + CHIP + storage on Galileo testnet** (16602) — is driven by
  the deterministic moderator, each decision is a live 0G-Compute TEE inference, spectators predict in CHIP
  across the markets, and `settle()` verifies every move's TEE signature + the commit-revealed roles +
  the Solidity rule re-execution before paying the winning outcome. A cross-layer Hardhat test settles a
  full `playMatch` transcript on-chain to the engine-declared winner.
- **Enabled in this deployment:** live 0G Compute (funded `COMPUTE_PRIVATE_KEY`), 0G Storage evidence
  with StorageScan/indexer links surfaced on the frontend (`ENABLE_STORAGE`), and the EIP-2771 gasless
  relayer (funded `RELAYER_PRIVATE_KEY`).
- **Code-complete but OFF here (key-gated):** spoken-dialogue **TTS** (ElevenLabs) — no
  `ELEVENLABS_API_KEY` / `ELEVENLABS_API_KEYS` set, so the feature is fully off and never ships keys to
  the browser. Turning it on is purely an env-key step (see `myTasks.md`).
- **Fast match starts (2026-07-09):** client-connect → predictions-open dropped from ~2 min to ~10-15s. The
  0G provider bundle is cached across rounds (one paid probe at boot, a per-round signer re-check), the
  persona evidence upload is prepared at boot / during the intermission instead of on the start path,
  the block schedule is sampled immediately before `createMatch` (10-block open margin, was 30+), tx
  receipt polling matches 0G's 0.5s blocks, and `createMatch` now seeds the Faction + MafiaSeat markets
  (4 props at creation — no post-create open txs; **deployed 2026-07-09**; the
  server auto-detects and still opens them on an old deployment). Per-step timing logs confirm the
  split each round.

## The markets (all categorical props, one verified `settle()`)

`MafiaMarket` is a matchId-keyed factory. Each match's markets are categorical parimutuel props
(`PropKind`): one pool per outcome, backers of the resolved outcome split the net pot pro-rata (minus
fee), and a market **Voids → full refund** when nobody backed the winner (or, for Faction, on a
mistrial). Server/UI address markets by reading each prop's `(kind, param)` — the kinds interleave, so
there is **no fixed index formula**.

| Kind | Question | Lifecycle | Outcomes |
|---|---|---|---|
| **Faction** | Which faction wins? | Opened first at match start (index 2) | TOWN (0) / MAFIA (1); mistrial → Void |
| **RoundVotedOut** | Who is voted out this round? | Recurring — round 1 auto-created; host floats each later round; freezes on that vote | one per seat + "no one" |
| **NightKill** | Who dies tonight? | Recurring — round 1 auto-created; host floats each later round; freezes at dawn | one per seat + "no one / all spared" |
| **MafiaSeat** | Who is the Mafia? | On-demand single | one per seat |
| **DetectiveClaim** | Is seat N's Detective claim real — or a bluff? | On-demand, per claiming seat | BLUFF / REAL |
| _PlayerFate_ | _(per-seat "what happens to this seat?")_ | **Retained in code, NOT floated for now** | FATE_BUCKETS |

At `createMatch` only the two recurring round-1 markets are minted (`propCount == 2`); Faction,
MafiaSeat and DetectiveClaim float on demand. The per-seat **PlayerFate/survival** market is no longer
minted — the `PropKind.PlayerFate` branch + `FATE_BUCKETS` stay intact so re-adding it is just
restoring a seat loop in `createMatch`.

### Prediction UX

- **Currency: CHIP** — a faucet-mintable mock ERC20 (`MockBetToken`, marked `# MOCK`), the one
  intentional mock. "Get test tokens" mints some in-app. All market mechanics it touches are real.
- **Gasless by default (EIP-2771).** A spectator with zero native 0G signs a `ForwardRequest`
  off-chain; the funded backend relayer submits it through the trusted `Forwarder` and pays gas while
  `_msgSender()` keeps the user as the on-chain predictor. On whenever the relayer is live + funded; a
  "⛽ Gasless" toggle opts out, and the UI falls back to the direct user-pays-gas path if the relayer
  is absent/broke. Real mechanism, not a mock.
- **Pop-up-free session keys.** An in-browser key is the on-chain predictor and signs relayed requests
  locally — no wallet pop-up per prediction. Two flavours: a **derived session** (one `personal_sign` seeds a
  deterministic key, cached per-owner) and a **guest burner** (random key for no-wallet visitors,
  persisted + restored). Caveat: a session/guest key holds no 0G, so it can predict only while the relayer
  is live + funded (the gasless path is forced, no silent gas fallback).
- **Batch claim.** One tap collects all winnings/refunds for a match (skip-don't-revert, single
  transfer) into a persistent winnings tray.
- **Open until settled.** Predictions stay open the whole match; a market only closes at settlement.
  Draws and "nobody backed the winner" (Void) refund stakes.

## Packages (npm workspaces) — all real, no mocks except CHIP

- **`engine/`** — the deterministic Mafia moderator: seeded role assignment (Fisher–Yates), night/day
  sequencing, doctor save, detective record, plurality tallies (tie → no elimination), parity/elimination
  win detection, canonical signed-decision encoding, and role commit-reveal
  (`commitRoles`/`verifyRoleReveal`, `sha256(roles ‖ salt)`). Pure, zero non-deterministic inputs.
  **37 tests.**
- **`players/`** — the player abstraction over 0G Compute TEE inference. Each seat holds its own
  `InferenceProvider` (BYOM-ready). A turn is two-layer: free-form `speech` + a constrained decision
  inference whose entire output IS the canonical decision string. The live path is `ZeroGDirectProvider`
  (Direct SDK, `qwen3.6-plus` on 0G mainnet); `MockLocalProvider` (real ECDSA, local key) covers offline/CI.
  `playMatch` drives the moderator with real calls, structures the day as a **trial** (nominate →
  prosecute → rebuttal → vote) and pauses on **in-loop prediction windows** (night-kill / voted-out /
  detective-claim), and captures the attested transcript. **226 tests** (+1 live-skipped).
- **`storage/`** — real `@0gfoundation/0g-storage-ts-sdk`. Canonical (sorted-key) serialization so
  identical evidence yields the same root; local root derivation; upload via in-memory `MemData` and
  download with merkle-proof verification. **Live-confirmed on Galileo.** **12 offline tests** (+2
  live-skipped).
- **`contracts/`** — `MafiaMarket` (categorical-prop parimutuel factory + `settle()` orchestration),
  `MockBetToken` (CHIP), `Forwarder` + `ERC2771Context`, and three pure libraries: `DecisionCodec`
  (reconstructs the engine's canonical decision JSON on-chain byte-for-byte), `TeeEnvelope` (rebuilds
  the real 0G-TEE envelope and `ecrecover`s the signer via the SHA-256 precompile + EIP-191), and
  `MafiaRules` (a faithful Solidity port of the moderator). **128 Hardhat tests.**
- **`server/`** — the Sequencer: drives the match, streams turns over WebSocket, opens/freezes the
  per-round markets as the match advances (`orchestrator.ts`), runs the gasless `/relay` endpoint and
  the key-gated `/tts` endpoint, and exposes a read-only `/status` for the lobby live-chip. **80 tests.**
- **`frontend/`** — the live arena UI: tribunal-styled match view, prediction panel for every market kind,
  session/guest wallet connect, CHIP faucet, batch claim + winnings tray, battle history, live-status
  chip, 0G Storage evidence links, and a (gated) TTS toggle. Type-check + `vite build` clean.

## 0G integration — confirmed facts (live)

Durable findings from real testnet calls (`players/scripts/live-turn.mjs`, `live-direct.mjs`).
Credentials live in `.env`; remaining human setup in `myTasks.md`.

- **Network — hybrid.** The **market, CHIP, settlement, and storage run on 0G Galileo Testnet:** chainId
  **16602**, EVM RPC `https://evmrpc-testnet.0g.ai`, explorer `https://chainscan-galileo.0g.ai`, faucet
  `https://faucet.0g.ai` — all free testnet 0G. **Inference runs on 0G mainnet** (Aristotle, chainId
  **16661**, RPC `https://evmrpc.0g.ai`) to reach far stronger models — that path spends **real
  mainnet 0G** (funded `COMPUTE_PRIVATE_KEY`, settled in batches; per-inference cost is tiny).
- **TEE attestation is `ecrecover`-viable** (EIP-191/ECDSA). The signature recovers to the mainnet
  provider's **`teeSignerAddress` `0xd45b…17d4`** (registered on-chain per match from the provider's own
  probe), distinct from the provider **account `0x992e…6db5`** used to address the service.
- **Signed bytes are an envelope, not our decision text:**
  `sha256(req):sha256(res):provider_type:provider_identity:tls_fingerprint`, colon-joined, EIP-191
  signed. So `settle()` takes the full response body + envelope fields + signature as calldata,
  recomputes `sha256(body)`, rebuilds the envelope, `ecrecover`s vs the registered signer, then parses
  the decision out of the body.
- **Compute — Direct SDK is the production path** (`@0gfoundation/0g-compute-ts-sdk`, funded wallet,
  returns the raw `{text, signature}` the verifier needs). Model **`qwen3.6-plus`** (0G mainnet TeeML);
  live-confirmed `tee_verified:true` (probe: 5-part envelope, `sha256(res)==part[1]`, signer match).
  A reasoning model run with `enable_thinking=false` (~0.7s TTFT, byte-exact signed decisions); pacing
  is bounded by the provider's ~10 req/min request throttle (no token cap surfaced on mainnet).
- **⚠️ Trust caveat (stated honestly in the demo):** the mainnet provider's signed metadata is still
  `provider_type: centralized, identity: aliyun` + an RA-TLS fingerprint. Per 0G's mainnet TeeML, a
  dstack/**Intel-TDX** serving enclave captures the exact req/res bytes and signs the envelope — so the
  operator **cannot forge, replay, or re-roll a move** (what matters for predictions) — but the **model runs
  on a centralized upstream (aliyun), not end-to-end in-enclave**, and we verify the signature on-chain,
  not the TDX attestation itself. The full defense design and exactly what is enforced on-chain today
  vs. designed-for-roadmap lives in `IDEA.md` (§ "Implementation Status").

## Mocks / stubs in place

- **The one intentional mock is `MockBetToken` (CHIP)** — a faucet-mintable test ERC20 with no value
  (`# MOCK`). Every market mechanic it touches is real.
- `engine/`, `players/`, `storage/`, `contracts/`, `server/`, `frontend/` are otherwise **all real**.
  The relayer/forwarder are real. Storage upload/download/round-trip is live-confirmed.
- **`MockLocalProvider`** remains for offline/CI: it produces the SAME envelope shape with real
  ECDSA/EIP-191 signatures, differing only in the signer (a labeled local key, `source: "MOCK-local"`)
  — never silently mistaken for a real attestation.

## What's next

The MVP is shipped and live; remaining work is breadth + polish, tracked in `TODO.md`
(security-hardening in `SECURITY.md`). Headline threads:

- **Game-loop drama** (`TODO.md` §6.2 → 6.3 → 6.5 → 6.6): an AI colour-commentator, a fuller trial arc,
  an "endgame / final table" mode, and the north-star beat-anchored micro-markets — off-chain feel work
  first, then the contract-touching pieces.
- **Deeper persona pool** (more distinct voices, Merkle-committed) and **more roles** (kept byte-for-byte
  in `engine/` and `MafiaRules.sol` in lockstep).
- **Deferred / larger initiatives:** host bond + slashing (`SECURITY.md` §S6), bring-your-own-model per seat
  (GPT vs Claude vs Llama as factions), production WebSocket scaling, explorer source verification.
