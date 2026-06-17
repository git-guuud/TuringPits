/**
 * 0G Storage integration — the Evidence Layer (TODO.md Day 3).
 *
 * Before a match: upload the two agent scripts, get back content roots.
 * After a match: upload the final PGN battle log, get back its root.
 * The oracle (Day 5) retrieves all three by root to re-run and verify.
 *
 * TODO(Day 3): wire @0glabs/0g-ts-sdk. Requires testnet creds — see myTasks.md.
 * Functions throw until implemented so nothing depends on a silent fake.
 */

/** A content-addressed handle returned by 0G Storage. */
export interface StorageRef {
  /** Merkle root / content identifier for the uploaded blob. */
  root: string;
}

/** Upload bytes to 0G Storage and return its content root. */
export async function upload(_data: Uint8Array): Promise<StorageRef> {
  throw new Error("storage.upload not implemented yet — see TODO.md Day 3");
}

/** Retrieve bytes from 0G Storage by content root. */
export async function download(_ref: StorageRef): Promise<Uint8Array> {
  throw new Error("storage.download not implemented yet — see TODO.md Day 3");
}
