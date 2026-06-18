import { Buffer } from "node:buffer";
import { hexlify, JsonRpcProvider, verifyMessage, Wallet } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
import { locateContent, resHashHex } from "./envelope.js";
import type { Attestation, InferenceProvider } from "./types.js";

/** 0G Galileo testnet (`STATUS.md` → confirmed facts). */
const GALILEO_CHAIN_ID = 16602;

export interface ZeroGDirectConfig {
  /** Funded wallet private key (`COMPUTE_PRIVATE_KEY`). Server-side only. */
  readonly privateKey: string;
  /** EVM RPC, e.g. `https://evmrpc-testnet.0g.ai`. */
  readonly rpcUrl: string;
  /** Provider account that addresses the service, e.g. `0xa48f…7836` (qwen2.5-omni). */
  readonly providerAddress: string;
  /** Minimum ledger balance (0G) to ensure on first use. SDK enforces a 3-0G floor. Default 3. */
  readonly minLedger?: number;
  readonly chainId?: number;
}

/**
 * REAL 0G Compute TEE inference via the **Direct SDK** — the live-confirmed raw-signature
 * path our on-chain verifier needs (`players/scripts/live-direct.mjs`,
 * `STATUS.md` → confirmed facts). NOT a mock.
 *
 * The earlier Router (`/chat/completions` + `verify_tee`) path was confirmed-WRONG for the
 * testnet router: it exposes no signature endpoint and returns only a `tee_verified` boolean.
 * The Direct SDK returns the provider-signed envelope
 * (`sha256(req):sha256(res):type:identity:tls`) that `MafiaMarket.settle()` reconstructs and
 * `ecrecover`s. Each `complete()`:
 *   1. `getRequestHeaders` (single-use billing headers) → POST `/chat/completions`.
 *   2. Capture the EXACT raw response bytes (their sha256 == envelope part[1]).
 *   3. `processResponse` (SDK-side TEE verification + fee settlement).
 *   4. `getChatSignatureDownloadLink` → fetch `{ text: envelope, signature }`.
 *   5. Verify the announced body hashes to the envelope, recover the signer == the
 *      registered `teeSignerAddress`, locate the decision content, return the attestation.
 *
 * Build it with {@link createZeroGDirectProvider}, which sets up the broker (ledger,
 * acknowledge signer) and resolves the service endpoint/model + TEE signer once.
 */
export class ZeroGDirectProvider implements InferenceProvider {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK broker type is internal
    private readonly broker: any,
    private readonly providerAddress: string,
    private readonly endpoint: string,
    private readonly model: string,
    /** The provider's registered TEE signer (envelope must recover to this). */
    readonly teeSignerAddress: string,
  ) {}

  async complete(prompt: string): Promise<{ text: string; attestation: Attestation }> {
    const headers = await this.broker.inference.getRequestHeaders(this.providerAddress, prompt);
    const res = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: prompt }] }),
    });
    // Capture the exact response bytes BEFORE parsing — sha256 of these is envelope part[1].
    const rawBodyStr = await res.text();
    if (!res.ok) throw new Error(`0G Compute inference failed: ${res.status} ${rawBodyStr}`);

    const chatId = res.headers.get("zg-res-key");
    if (!chatId) throw new Error("0G Compute response missing zg-res-key (needed for signature)");

    const body = JSON.parse(rawBodyStr) as {
      choices?: { message?: { content?: string } }[];
      usage?: unknown;
    };
    const text = body.choices?.[0]?.message?.content;
    if (text == null) throw new Error("0G Compute response had no message content");

    // SDK-side TEE verification + fee settlement (gates billing; must run per request).
    await this.broker.inference.processResponse(this.providerAddress, chatId, JSON.stringify(body.usage ?? {}));

    const link = await this.broker.inference.getChatSignatureDownloadLink(this.providerAddress, chatId);
    const sigRes = await fetch(link, { headers });
    if (!sigRes.ok) throw new Error(`0G Compute signature fetch failed: ${sigRes.status} ${await sigRes.text()}`);
    const { text: envelope, signature } = (await sigRes.json()) as { text: string; signature: string };

    // Envelope = reqHash:resHash:providerType:providerIdentity:tlsFingerprint.
    const parts = envelope.split(":");
    if (parts.length !== 5) throw new Error(`unexpected 0G-TEE envelope shape (${parts.length} parts)`);
    const [reqHashHex, signedResHash, providerType, providerIdentity, tlsFingerprint] = parts as [string, string, string, string, string];

    const rawResponseBody = hexlify(Buffer.from(rawBodyStr, "utf8"));
    if (resHashHex(rawResponseBody) !== signedResHash) {
      throw new Error("0G-TEE envelope res-hash does not match the captured response body");
    }
    const recovered = verifyMessage(envelope, signature);
    if (recovered.toLowerCase() !== this.teeSignerAddress.toLowerCase()) {
      throw new Error(`0G-TEE signature recovered ${recovered}, expected signer ${this.teeSignerAddress}`);
    }

    const { contentOffset, contentLen } = locateContent(Buffer.from(rawBodyStr, "utf8"), text);
    const attestation: Attestation = {
      signature,
      signerAddress: this.teeSignerAddress,
      source: "0g-tee",
      rawResponseBody,
      contentOffset,
      contentLen,
      reqHashHex,
      providerType,
      providerIdentity,
      tlsFingerprint,
    };
    return { text, attestation };
  }
}

/**
 * Set up the 0G Compute broker and resolve the service for one provider, returning a ready
 * {@link ZeroGDirectProvider}. Ensures a funded ledger (creates one at `minLedger` 0G if
 * absent) and acknowledges the provider's TEE signer (idempotent), mirroring
 * `players/scripts/live-direct.mjs`. The caller passes `.env` values — this reads no globals.
 */
export async function createZeroGDirectProvider(config: ZeroGDirectConfig): Promise<ZeroGDirectProvider> {
  const { privateKey, rpcUrl, providerAddress, minLedger = 3, chainId = GALILEO_CHAIN_ID } = config;
  const wallet = new Wallet(privateKey, new JsonRpcProvider(rpcUrl, chainId));
  const broker = await createZGComputeNetworkBroker(wallet);

  try {
    await broker.ledger.getLedger();
  } catch {
    await broker.ledger.addLedger(minLedger); // SDK enforces a 3-0G minimum
  }

  const status = await broker.inference.checkProviderSignerStatus(providerAddress);
  if (!status.isAcknowledged) {
    await broker.inference.acknowledgeProviderSigner(providerAddress);
  }

  const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
  return new ZeroGDirectProvider(broker, providerAddress, endpoint, model, status.teeSignerAddress);
}
