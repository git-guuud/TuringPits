import { createHash } from "node:crypto";
import { Wallet } from "ethers";
import type { BaseWallet } from "ethers";
import { encodeDecision } from "@turingpits/engine";
import type { Decision } from "@turingpits/engine";
import type { Attestation, InferenceProvider } from "./types.js";

/**
 * Default deterministic "model" for the mock provider. It reads our own prompt format
 * the way a real LLM would read the prompt — emitting a canonical decision string for a
 * decision prompt, and canned in-character prose for a speech prompt. Deterministic
 * (seeded by the prompt text) so mock matches are reproducible.
 */
function mockRespond(prompt: string): string {
  const skeletonLine = prompt.split("\n").find((l) => l.trimStart().startsWith('{"nonce"'));
  const legalMatch = prompt.match(/Legal target seats?: ([\d, ]+)/);

  if (skeletonLine && legalMatch) {
    const skeleton = JSON.parse(skeletonLine.trim()) as Decision;
    const legal = legalMatch[1]!.split(",").map((s) => Number(s.trim())).filter(Number.isInteger);
    // Deterministic pick: hash the whole prompt to an index into the legal set.
    const h = createHash("sha256").update(prompt).digest();
    const target = legal[h.readUInt32BE(0) % legal.length]!;
    return encodeDecision({ ...skeleton, target });
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
 * # MOCK: local-key inference provider used ONLY when live 0G Compute access is
 * unavailable (`myTasks.md §B` not yet provisioned).
 *
 * The signature is real ECDSA / EIP-191 — so the verification path is genuinely
 * exercised — but the signer is a LOCAL test key, NOT a 0G TEE provider. `source` is
 * always `"MOCK-local"`, so nothing here is ever mistaken for a real attestation. Swap in
 * `ZeroGComputeProvider` once credentials land; no other code changes.
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

  async complete(prompt: string): Promise<{ text: string; attestation: Attestation }> {
    const text = this.respond(prompt);
    const signature = await this.wallet.signMessage(text);
    const attestation: Attestation = {
      signedText: text,
      signature,
      signerAddress: this.wallet.address,
      source: "MOCK-local",
    };
    return { text, attestation };
  }
}
