import type { Attestation, InferenceProvider } from "./types.js";

export interface ZeroGComputeConfig {
  /** Router base URL, e.g. `https://router-api.0g.ai/v1` (`myTasks.md §B`). */
  readonly baseUrl: string;
  /** `sk-...` inference key from pc.0g.ai. Server-side only — never ship to a browser. */
  readonly apiKey: string;
  /** Model id from the live catalog, e.g. `zai-org/GLM-5-FP8` (`myTasks.md §B`). */
  readonly model: string;
  /**
   * The provider's `teeSignerAddress` read from the on-chain service record
   * (`myTasks.md §A`). The attestation's recovered signer is checked against this — the
   * same key the Day-5 contract registers. Required so a provider can't swap keys on us.
   */
  readonly teeSignerAddress: string;
}

/**
 * REAL 0G Compute TEE inference via the OpenAI-compatible Router (`myTasks.md §B`).
 * This is the production path — NOT a mock. It is unexercised until the §B credentials
 * are provisioned (no API key / model chosen yet), and the exact wire details flagged
 * `// PENDING LIVE CONFIRMATION` are hardened on Day 3 against a live endpoint.
 *
 * Flow (per docs review in `myTasks.md` Findings §A/§B):
 *  1. POST /chat/completions with `verify_tee: true` → response text + `x_0g_trace`.
 *  2. GET /proxy/signature/{chatID} → `{ text, signature }` (EIP-191 over the text).
 *  3. Return the text + an attestation whose signer must be the registered TEE key.
 */
export class ZeroGComputeProvider implements InferenceProvider {
  constructor(private readonly config: ZeroGComputeConfig) {}

  async complete(prompt: string): Promise<{ text: string; attestation: Attestation }> {
    const { baseUrl, apiKey, model, teeSignerAddress } = this.config;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        verify_tee: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`0G Compute inference failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      id?: string;
      choices: { message: { content: string } }[];
      x_0g_trace?: { tee_verified?: boolean; provider?: string };
    };

    const text = body.choices[0]?.message.content ?? "";
    // CONFIRMED LIVE (2026-06-17): chatID is the `zg-res-key` response header (a UUID),
    // not `body.id` (`chatcmpl-…`). See myTasks.md §A "LIVE CONFIRMATION".
    const chatId = res.headers.get("zg-res-key") ?? body.id;
    if (!chatId) throw new Error("0G Compute response missing chat id (needed for signature)");

    // ⚠️ CONFIRMED-WRONG for the integratenetwork testnet router: it exposes NO
    // /v1/proxy/signature endpoint (all shapes 404) — it only returns `tee_verified`. The
    // raw {text, signature} our on-chain verifier needs comes from the Direct SDK
    // (broker.inference.processResponse, funded wallet). This Router signature fetch stays
    // here for the official router-api.0g.ai path; Day-3 adds the Direct provider.
    const sigRes = await fetch(
      `${baseUrl}/proxy/signature/${chatId}?model=${encodeURIComponent(model)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!sigRes.ok) {
      throw new Error(`0G Compute signature fetch failed: ${sigRes.status} ${await sigRes.text()}`);
    }
    const { text: signedText, signature } = (await sigRes.json()) as {
      text: string;
      signature: string;
    };

    if (signedText !== text) {
      // The provider must sign the exact text it returned, or settlement can't reconstruct it.
      throw new Error("0G Compute attestation text does not match the response content");
    }

    return {
      text,
      attestation: { signedText, signature, signerAddress: teeSignerAddress, source: "0g-tee" },
    };
  }
}
