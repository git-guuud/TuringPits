/**
 * Revert-reason recovery for MINED status-0 transactions.
 *
 * When a tx passes gas estimation but reverts at inclusion (a state race — e.g. createMatch's
 * "open in past" losing to the chain during broadcast), ethers throws CALL_EXCEPTION with
 * reason=null: a receipt carries no revert data. The reason is still recoverable by replaying
 * the identical call via eth_call against the parent block's state.
 *
 * The replay is exact only when no earlier tx in the same block touched the relevant state; for
 * block-height requires like "open in past" it is reliable regardless of ordering — the block
 * height is the same for every tx in the block.
 */

/** The slice of an ethers Provider the replay needs (injectable for tests). */
export interface ReplayProvider {
  getTransaction(hash: string): Promise<{ from: string; to: null | string; data: string } | null>;
  call(tx: { from: string; to: null | string; data: string; blockTag: number }): Promise<string>;
}

/** Best-effort: the revert reason of a mined status-0 tx, or undefined when the error isn't a
 *  mined revert / the replay can't recover a decodable Error(string). Never throws. */
export async function recoverMinedRevertReason(
  err: unknown,
  provider: ReplayProvider,
): Promise<string | undefined> {
  const receipt = (err as { receipt?: { status?: null | number; hash?: string; blockNumber?: number } })?.receipt;
  if (!receipt || receipt.status !== 0 || !receipt.hash || typeof receipt.blockNumber !== "number") {
    return undefined;
  }
  try {
    const tx = await provider.getTransaction(receipt.hash);
    if (!tx) return undefined;
    await provider.call({ from: tx.from, to: tx.to, data: tx.data, blockTag: receipt.blockNumber - 1 });
    return undefined; // replay didn't revert — the reason is lost to state drift
  } catch (replayErr) {
    const reason = (replayErr as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : undefined;
  }
}
