import { Buffer } from "node:buffer";
import { hexlify, sha256 } from "ethers";

/**
 * Provider metadata that forms envelope parts[2..4]
 * (`reqHash:resHash:providerType:providerIdentity:tlsFingerprint`). Constant per provider.
 */
export interface ProviderMeta {
  readonly providerType: string;
  readonly providerIdentity: string;
  readonly tlsFingerprint: string;
}

/**
 * The live testnet provider's signed metadata (`STATUS.md` → confirmed facts): a centralized
 * Aliyun endpoint with an RA-TLS fingerprint — NOT visibly hardware Intel-TDX. The mock reuses
 * these exact values (matching `contracts/test/helpers/envelope.ts`) so a mock-produced move is
 * byte-identical in shape to a live one and verifies against the same on-chain envelope path.
 */
export const MOCK_PROVIDER_META: ProviderMeta = {
  providerType: "centralized",
  providerIdentity: "aliyun",
  tlsFingerprint: "sha256/AAAABBBBCCCCDDDDEEEEFFFF0000111122223333=",
};

/** Lowercase hex (no `0x`) of `sha256(bytes)` — the envelope's hash field encoding. */
export function resHashHex(bytesHex: string): string {
  return sha256(bytesHex).slice(2);
}

/** Join the five envelope fields exactly as `TeeEnvelope.sol` does before EIP-191 signing. */
export function joinEnvelope(reqHashHex: string, rawResponseBody: string, meta: ProviderMeta): string {
  return [reqHashHex, resHashHex(rawResponseBody), meta.providerType, meta.providerIdentity, meta.tlsFingerprint].join(":");
}

export interface WrappedBody {
  /** 0x-hex of the UTF-8 response-body bytes (what the contract takes as `bytes`). */
  readonly rawResponseBody: string;
  /** Byte offset of `content` within the body. */
  readonly contentOffset: number;
  /** Byte length of `content` as it appears (JSON-escaped) in the body. */
  readonly contentLen: number;
}

/**
 * Wrap model `content` in an OpenAI chat-completion response body and locate the content bytes
 * inside it. Mirrors the body shape `contracts/test/helpers/envelope.ts` builds, so the
 * `contentOffset`/`contentLen` slice the contract checks (`_sliceEquals`) lands on exactly the
 * JSON-escaped content. Used by the mock; the live provider gets its body from 0G Compute and
 * only reuses the offset-locating logic via `locateContent`.
 */
export function wrapResponseBody(content: string): WrappedBody {
  const body = JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const bodyBytes = Buffer.from(body, "utf8");
  return { rawResponseBody: hexlify(bodyBytes), ...locateContent(bodyBytes, content) };
}

/**
 * Find where `content` appears (JSON-escaped, as a string value) within a raw response body.
 * The contract slices these exact bytes and compares them to the canonical decision string, so
 * the offset/length must be in body bytes, not characters.
 */
export function locateContent(bodyBytes: Buffer, content: string): { contentOffset: number; contentLen: number } {
  const embedded = JSON.stringify(content).slice(1, -1); // escape exactly as it sits in the body
  const embeddedBytes = Buffer.from(embedded, "utf8");
  const contentOffset = bodyBytes.indexOf(embeddedBytes);
  if (contentOffset < 0) throw new Error("response content not found in body (cannot bind decision)");
  return { contentOffset, contentLen: embeddedBytes.length };
}
