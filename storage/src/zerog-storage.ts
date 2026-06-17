/**
 * 0G Storage integration — the Evidence Layer (TODO.md Day 4).
 *
 * Real uploads/downloads against 0G Storage (Galileo testnet). Bytes go up via the SDK's
 * in-memory `MemData` (no temp files), the upload tx is paid by the configured wallet, and
 * the content is addressed by its merkle `root`. Downloads come back in-memory via
 * `downloadToBlob`. The round-trip is hash-stable: downloaded bytes equal uploaded bytes.
 *
 * Endpoints + signer come from a `StorageConfig` (the caller loads them from `.env`); the
 * library itself reads no globals, so it stays testable and explicit.
 */
import { Indexer, MemData } from "@0gfoundation/0g-storage-ts-sdk";
import { JsonRpcProvider, Wallet } from "ethers";

/** A content-addressed handle returned by 0G Storage. */
export interface StorageRef {
  /** Merkle root / content identifier for the uploaded blob. */
  root: string;
}

/** Endpoints + signer for a 0G Storage client. Caller supplies these (e.g. from `.env`). */
export interface StorageConfig {
  /** Indexer URL, e.g. https://indexer-storage-testnet-turbo.0g.ai */
  readonly indexerUrl: string;
  /** EVM RPC URL used to submit the storage tx, e.g. https://evmrpc-testnet.0g.ai */
  readonly rpcUrl: string;
  /** Private key of the wallet that pays for uploads. */
  readonly privateKey: string;
  /** 0G Galileo testnet chainId. Defaults to 16602. */
  readonly chainId?: number;
}

/**
 * The 0G Storage merkle root of `bytes` — the content identifier the network addresses
 * data by. Computed locally (no network), so it can be derived and checked offline.
 */
export async function root(bytes: Uint8Array): Promise<string> {
  const [tree, err] = await new MemData(bytes).merkleTree();
  if (err !== null || tree === null) {
    throw new Error(`failed to compute 0G Storage root: ${err}`);
  }
  const r = tree.rootHash();
  if (r === null) throw new Error("0G Storage merkle tree produced a null root");
  return r;
}

export interface ZeroGStorage {
  /** Upload bytes to 0G Storage; returns the content root once the tx lands. */
  upload(bytes: Uint8Array): Promise<StorageRef>;
  /** Retrieve bytes from 0G Storage by content root (with merkle proof verification). */
  download(ref: StorageRef): Promise<Uint8Array>;
}

/** Construct a 0G Storage client bound to the given endpoints and signer. */
export function createZeroGStorage(config: StorageConfig): ZeroGStorage {
  const indexer = new Indexer(config.indexerUrl);
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId ?? 16602);
  const signer = new Wallet(config.privateKey, provider);

  return {
    async upload(bytes: Uint8Array): Promise<StorageRef> {
      const file = new MemData(bytes);
      // skipIfFinalized: re-uploading identical evidence is a no-op (no duplicate tx).
      const [res, err] = await indexer.upload(file, config.rpcUrl, signer, {
        skipIfFinalized: true,
      });
      if (err !== null) throw new Error(`0G Storage upload failed: ${err}`);
      const rootHash = "rootHash" in res ? res.rootHash : res.rootHashes[0]!;
      return { root: rootHash };
    },

    async download(ref: StorageRef): Promise<Uint8Array> {
      // proof: true → the SDK verifies each segment's merkle proof against the root.
      const [blob, err] = await indexer.downloadToBlob(ref.root, { proof: true });
      if (err !== null) throw new Error(`0G Storage download failed: ${err}`);
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}
