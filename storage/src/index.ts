/**
 * @turingpits/storage — 0G Storage integration, the Evidence Layer (TODO.md Day 4).
 *
 * Before a match: upload each seat's public persona, get back a content root.
 * After a match: upload the full attested transcript (speech + structured decisions + TEE
 * signatures), get back its root. Either can be retrieved by root and is hash-stable.
 */
export {
  canonicalJson,
  decodeJson,
  serializeMatch,
  serializePersonas,
  sha256Hex,
} from "./serialize.js";

export {
  createZeroGStorage,
  root,
  type StorageConfig,
  type StorageRef,
  type ZeroGStorage,
} from "./zerog-storage.js";
