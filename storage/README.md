# @turingpits/storage

0G Storage integration — the **Evidence Layer**.

- **Pre-match:** upload each seat's public persona (locked before betting opens).
- **Post-match:** upload the full attested transcript — speech + structured decisions +
  every TEE signature.
- Round-trip is hash-stable: downloaded bytes == uploaded bytes.

## API

- `serializePersonas(personas)` / `serializeMatch({winner, turns})` → canonical bytes
  (recursively sorted keys, compact) so the same evidence always yields the same root.
- `root(bytes)` → the 0G Storage merkle root (computed locally, no network).
- `createZeroGStorage({indexerUrl, rpcUrl, privateKey})` → `{ upload(bytes), download(ref) }`,
  real uploads/downloads against 0G Storage via in-memory `MemData` / `downloadToBlob`.
- `sha256Hex(bytes)` for the immutability check.

Uses `@0gfoundation/0g-storage-ts-sdk`. Endpoints + signer are passed in by the caller
(loaded from `.env`); the library reads no globals.

## Tests

- Offline (default `npm test`): serialization determinism + canonical round-trip, and the
  real SDK merkle-root computation. No network, no funds.
- Live (`storage/src/live.test.ts`, skipped unless `RUN_LIVE_STORAGE=1`): a real round-trip
  against 0G Storage testnet — upload persona + transcript, download by root, assert
  byte/hash equality. Run it with credentials loaded:

  ```sh
  RUN_LIVE_STORAGE=1 node --env-file=.env \
    ./node_modules/vitest/vitest.mjs run storage/src/live.test.ts
  ```

This layer is **real** (no silent mocks). The sample evidence in the live test carries a
`source: "MOCK-local"` attestation only because wiring the live TEE provider into a full
match is Day-5 work — the storage upload/download/round-trip itself is genuine.
