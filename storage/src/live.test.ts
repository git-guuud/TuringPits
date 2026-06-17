/**
 * LIVE integration against 0G Storage (Galileo testnet) — the Day-4 exit-criteria proof.
 *
 * Skipped by default so the offline suite needs no network or funds. Run it explicitly with
 * real credentials loaded (see `.env`):
 *
 *   RUN_LIVE_STORAGE=1 node --env-file=.env \
 *     node_modules/.bin/vitest run storage/src/live.test.ts
 *
 * It uploads real persona + transcript evidence, downloads it back by root, and asserts the
 * bytes are hash-identical — confirming immutable, content-addressed storage end to end.
 */
import { describe, expect, it } from "vitest";
import {
  createZeroGStorage,
  root,
  serializeMatch,
  serializePersonas,
  sha256Hex,
  type StorageConfig,
} from "./index.js";

const RUN = process.env.RUN_LIVE_STORAGE === "1";

function configFromEnv(): StorageConfig {
  const indexerUrl = process.env.ZEROG_STORAGE_INDEXER_URL;
  const rpcUrl = process.env.ZEROG_STORAGE_RPC_URL ?? process.env.ZEROG_RPC_URL;
  const privateKey = process.env.COMPUTE_PRIVATE_KEY;
  if (!indexerUrl || !rpcUrl || !privateKey) {
    throw new Error(
      "live storage test needs ZEROG_STORAGE_INDEXER_URL, ZEROG_STORAGE_RPC_URL, COMPUTE_PRIVATE_KEY",
    );
  }
  return { indexerUrl, rpcUrl, privateKey };
}

const personas = [
  { seat: 0, name: "Ada", blurb: "calm tactician who watches the vote math" },
  { seat: 1, name: "Bo", blurb: "loud accuser, first to point fingers" },
  { seat: 2, name: "Cy", blurb: "quiet until it counts" },
];

const match = {
  winner: "TOWN" as const,
  turns: [
    {
      seat: 1,
      speech: "Seat 2 has been dodging every question — I vote them.",
      structuredDecision: {
        nonce: "live-evidence-nonce",
        phase: "day" as const,
        round: 1,
        player: 1,
        action: "vote" as const,
        target: 2,
      },
      attestation: {
        signedText:
          '{"nonce":"live-evidence-nonce","phase":"day","round":1,"player":1,"action":"vote","target":2}',
        signature: "0x" + "ab".repeat(65),
        signerAddress: "0x83df000000000000000000000000000000000008",
        source: "MOCK-local" as const,
      },
    },
  ],
};

describe.skipIf(!RUN)("0G Storage live round-trip", () => {
  it(
    "uploads personas and retrieves byte-identical evidence by root",
    async () => {
      const storage = createZeroGStorage(configFromEnv());
      const bytes = serializePersonas(personas);

      const ref = await storage.upload(bytes);
      expect(ref.root).toBe(await root(bytes)); // announced root == locally-derived root
      console.log("personas root:", ref.root);

      const back = await storage.download(ref);
      expect(sha256Hex(back)).toBe(sha256Hex(bytes));
      expect(back).toEqual(bytes);
    },
    180_000,
  );

  it(
    "uploads the full attested transcript and retrieves it byte-identical by root",
    async () => {
      const storage = createZeroGStorage(configFromEnv());
      const bytes = serializeMatch(match);

      const ref = await storage.upload(bytes);
      expect(ref.root).toBe(await root(bytes));
      console.log("transcript root:", ref.root);

      const back = await storage.download(ref);
      expect(sha256Hex(back)).toBe(sha256Hex(bytes));
      expect(back).toEqual(bytes);
    },
    180_000,
  );
});
