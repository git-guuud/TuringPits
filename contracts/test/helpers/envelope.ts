import { sha256, toUtf8Bytes, hexlify, type Wallet } from "ethers";

export const PROVIDER_META = {
  providerType: "centralized",
  providerIdentity: "aliyun",
  tlsFingerprint: "sha256/AAAABBBBCCCCDDDDEEEEFFFF0000111122223333=",
};

export interface BuiltMove {
  rawResponseBody: string; // 0x-hex of the UTF-8 body
  contentOffset: number;
  contentLen: number;
  reqHashHex: string;
  signature: string;
}

/**
 * Build a REAL-shaped 0G-TEE envelope over a synthetic OpenAI-JSON body whose
 * choices[0].message.content IS `decisionStr`. Signed EIP-191 by `wallet` (a labeled local
 * key registered as teeSigner). Verification mechanism is real; only the signer is local.
 */
export async function buildEnvelope(
  wallet: Wallet,
  decisionStr: string,
  meta = PROVIDER_META,
): Promise<BuiltMove> {
  const body = JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: decisionStr }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const bodyBytes = Buffer.from(body, "utf8");

  // The decision appears in the body as a JSON string value (quotes escaped).
  const embedded = JSON.stringify(decisionStr).slice(1, -1);
  const embeddedBytes = Buffer.from(embedded, "utf8");
  const contentOffset = bodyBytes.indexOf(embeddedBytes);
  if (contentOffset < 0) throw new Error("decision content not found in body");
  const contentLen = embeddedBytes.length;

  const resHashHex = sha256(bodyBytes).slice(2); // lowercase hex, no 0x
  // part[0] = sha256(request) is opaque to the contract; any 64-hex is fine for tests.
  const reqHashHex = sha256(toUtf8Bytes("request:" + decisionStr)).slice(2);
  const envelope = `${reqHashHex}:${resHashHex}:${meta.providerType}:${meta.providerIdentity}:${meta.tlsFingerprint}`;
  const signature = await wallet.signMessage(envelope); // EIP-191 personal_sign

  return { rawResponseBody: hexlify(bodyBytes), contentOffset, contentLen, reqHashHex, signature };
}
