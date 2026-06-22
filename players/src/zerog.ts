import { Buffer } from "node:buffer";
import { hexlify, JsonRpcProvider, verifyMessage, Wallet } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
import { locateContent, resHashHex, type ProviderMeta } from "./envelope.js";
import { createMinIntervalThrottle, type Throttle } from "./throttle.js";
import { withRetry, isTransientError } from "./retry.js";
import type { Attestation, InferenceProvider } from "./types.js";

/** 0G Galileo testnet (`STATUS.md` → confirmed facts). */
const GALILEO_CHAIN_ID = 16602;

/**
 * Minimum spacing between inference requests (ms). The testnet provider caps `/chat/completions`
 * at 10 requests/min; 6.5s/request stays just under that with margin. Override via config.
 */
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 6500;

/**
 * Coerce a sampling seed into the value the 0G/vLLM backend accepts: a non-negative signed
 * 32-bit integer. `callSeed` (players/src/player.ts) produces a uint32 that can exceed
 * 2^31-1, which the provider rejects with `400 'seed' must be Integer`. Truncating + masking
 * to 31 bits keeps it deterministic while staying in range. `& 0x7fffffff` also forces an
 * integer, so any stray float/NaN becomes a valid value too.
 */
export function toProviderSeed(seed: number): number {
  return Math.trunc(seed) & 0x7fffffff;
}

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
  /** Minimum ms between inference requests (provider rate limit). Default 6500 (≈9/min). */
  readonly minRequestIntervalMs?: number;
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
    /** Paces requests under the provider's rate limit (see {@link createMinIntervalThrottle}). */
    private readonly throttle: Throttle = createMinIntervalThrottle(DEFAULT_MIN_REQUEST_INTERVAL_MS),
  ) {}

  /**
   * The provider's signed envelope metadata (providerType / providerIdentity / tlsFingerprint),
   * captured once at setup. Constant per provider, and the EXACT values the on-chain verifier
   * must be registered with so `ecrecover` matches — see {@link createZeroGDirectProvider}.
   */
  meta?: ProviderMeta;

  async complete(
    prompt: string,
    opts?: import("./types.js").SamplingOptions,
  ): Promise<{ text: string; attestation: Attestation }> {
    // Retry transient network failures (testnet drops connections); each attempt re-throttles so
    // retries also respect the rate limit. Reverts / 4xx (e.g. bad seed) are NOT retried.
    return withRetry(() => this.completeOnce(prompt, opts), {
      isRetryable: isTransientError,
      onRetry: (e, attempt, d) =>
        console.warn(`[0g] transient inference failure (retry ${attempt} in ${d}ms): ${(e as Error).message ?? e}`),
    });
  }

  private async completeOnce(
    prompt: string,
    opts?: import("./types.js").SamplingOptions,
  ): Promise<{ text: string; attestation: Attestation }> {
    // Space requests out so a burst of turns stays under the provider's per-minute cap.
    await this.throttle();
    const headers = await this.broker.inference.getRequestHeaders(this.providerAddress, prompt);
    const reqBody: Record<string, unknown> = { model: this.model, messages: [{ role: "user", content: prompt }] };
    // Sampling params on the request do NOT affect settlement: the TEE envelope signs the
    // RESPONSE, and reqHashHex (envelope part[0]) is the provider's own request hash.
    if (opts?.temperature !== undefined) reqBody.temperature = opts.temperature;
    if (opts?.seed !== undefined) reqBody.seed = toProviderSeed(opts.seed);
    const res = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(reqBody),
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
  const {
    privateKey,
    rpcUrl,
    providerAddress,
    minLedger = 3,
    chainId = GALILEO_CHAIN_ID,
    minRequestIntervalMs = DEFAULT_MIN_REQUEST_INTERVAL_MS,
  } = config;
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
  const provider = new ZeroGDirectProvider(
    broker,
    providerAddress,
    endpoint,
    model,
    status.teeSignerAddress,
    createMinIntervalThrottle(minRequestIntervalMs),
  );

  // Probe once to capture the provider's REAL signed envelope metadata (type/identity/tls).
  // These must be registered on-chain verbatim or settle() reverts "bad TEE signature": the
  // signer signs over its real tlsFingerprint, not a placeholder. Constant per provider.
  const { attestation } = await provider.complete("Reply with one short word to establish provider metadata.");
  provider.meta = {
    providerType: attestation.providerType,
    providerIdentity: attestation.providerIdentity,
    tlsFingerprint: attestation.tlsFingerprint,
  };
  return provider;
}
