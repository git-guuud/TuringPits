import { createHash } from "node:crypto";
import { sha256, toUtf8Bytes, Wallet } from "ethers";
import type { BaseWallet } from "ethers";
import { encodeDecision } from "@turingpits/engine";
import type { Decision } from "@turingpits/engine";
import { joinEnvelope, MOCK_PROVIDER_META, wrapResponseBody } from "./envelope.js";
import type { Attestation, InferenceProvider } from "./types.js";

/**
 * Default deterministic "model" for the mock provider. It reads our own prompt format
 * the way a real LLM would read the prompt — emitting a canonical decision string for a
 * decision prompt, and canned in-character prose for a speech prompt. Deterministic
 * (seeded by the prompt text) so mock matches are reproducible.
 */
function mockRespond(prompt: string): string {
  const skeletonLine = prompt.split("\n").find((l) => l.trimStart().startsWith('{"nonce"'));
  if (skeletonLine) {
    // Decision prompt → echo the already-pinned skeleton verbatim (canonical), the way a
    // compliant model copies the exact line it was told to output.
    const skeleton = JSON.parse(skeletonLine.trim()) as Decision;
    return encodeDecision(skeleton);
  }

  // All target-bearing prompts carry a "Legal target(s)…" line; pull every legal seat from it
  // (handles both the bare "Legal target seats: 0, 1" form and the roster "Name (seat 0), …" form).
  const legalLine = prompt.split("\n").find((l) => /Legal target/i.test(l));
  const legal = legalLine ? (legalLine.match(/\d+/g) ?? []).map(Number) : [];
  const pick = (): number => {
    const h = createHash("sha256").update(prompt).digest();
    return legal.length ? legal[h.readUInt32BE(0) % legal.length]! : 0;
  };

  if (prompt.includes("TARGET: <the seat NUMBER")) {
    // Merged day-vote prompt → emit the two labelled lines `parseVoteSpeech` expects: a legal target
    // and a clean in-character case (free text, so it can never be mistaken for a decision).
    const target = pick();
    return `TARGET: ${target}\nCASE: Seat ${target} keeps dodging the real questions, so they get my vote today.`;
  }

  if (legalLine && legal.length > 0) {
    // Reason prompt (night) → pick a legal target deterministically and emit the `{target, reason}`
    // object `parseReason` expects.
    const target = pick();
    return JSON.stringify({ target, reason: `seat ${target} is the likeliest threat by my read` });
  }

  // Speech prompt → free-form prose (never valid JSON, so it can't be mistaken for a decision).
  const lines = [
    "I've been watching the table, and something doesn't add up here.",
    "Let's stay calm — accusing the loudest voice rarely ends well.",
    "My read is that the quiet ones are coordinating. I'm leaning a certain way.",
    "I'll say my piece: trust is earned, and I haven't seen much of it yet.",
  ];
  const h = createHash("sha256").update(prompt).digest();
  return lines[h.readUInt32BE(0) % lines.length]!;
}

/**
 * # MOCK: local-key inference provider used when live 0G Compute access is unavailable or
 * undesirable (e.g. offline/CI). The real path is `ZeroGDirectProvider` (`zerog.ts`).
 *
 * It produces the SAME envelope shape as a live attestation — wraps the model `content` in an
 * OpenAI-style response body and signs the real 0G-TEE envelope
 * (`reqHash:sha256(body):type:identity:tls`) with EIP-191 — so the verification path is
 * genuinely exercised and a mock-produced move settles on the deployed contract unchanged.
 * The ONLY difference from a real attestation is the signer: a LOCAL test key, never a 0G TEE
 * provider. `source` is always `"MOCK-local"`, so nothing here is mistaken for a real
 * attestation. Swap in `ZeroGDirectProvider` once a funded match runs; no other code changes.
 */
export class MockLocalProvider implements InferenceProvider {
  private readonly wallet: BaseWallet;
  private readonly respond: (prompt: string) => string;

  constructor(privateKey?: string, respond: (prompt: string) => string = mockRespond) {
    this.wallet = privateKey ? new Wallet(privateKey) : Wallet.createRandom();
    this.respond = respond;
  }

  get signerAddress(): string {
    return this.wallet.address;
  }

  async complete(
    prompt: string,
    _opts?: import("./types.js").SamplingOptions,
  ): Promise<{ text: string; attestation: Attestation }> {
    const text = this.respond(prompt);
    const { rawResponseBody, contentOffset, contentLen } = wrapResponseBody(text);
    // part[0] = sha256(request) is opaque to the verifier; a deterministic local hash stands
    // in for the provider's own request serialization.
    const reqHashHex = sha256(toUtf8Bytes("request:" + text)).slice(2);
    const envelope = joinEnvelope(reqHashHex, rawResponseBody, MOCK_PROVIDER_META);
    const signature = await this.wallet.signMessage(envelope);

    const attestation: Attestation = {
      signature,
      signerAddress: this.wallet.address,
      source: "MOCK-local",
      rawResponseBody,
      contentOffset,
      contentLen,
      reqHashHex,
      ...MOCK_PROVIDER_META,
    };
    return { text, attestation };
  }
}
