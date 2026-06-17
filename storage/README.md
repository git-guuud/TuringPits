# @turingpits/storage

0G Storage integration — the **Evidence Layer**.

- Pre-match: upload both agent scripts (locked before betting opens).
- Post-match: upload the final PGN battle log.
- Round-trip must be hash-stable: downloaded bytes == uploaded bytes.

`upload(bytes) -> StorageRef` and `download(ref) -> bytes`. Implementation lands on
Day 3 using `@0glabs/0g-ts-sdk`; needs testnet credentials/funds (see `myTasks.md`).

Do not silently mock this layer. If a stub is unavoidable while creds are pending,
mark it `// MOCK:` and flag it in `STATUS.md`.
