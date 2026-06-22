/**
 * Builds the seats and runs the real engine/players match. The provider is the repo's own:
 * `ZeroGDirectProvider` (live 0G-TEE inference) when COMPUTE_PRIVATE_KEY is set, else
 * `MockLocalProvider` — a real local ECDSA signer whose moves settle on-chain identically
 * (PlayersIntegration.test.ts), labeled `MOCK-local`. This is NOT frontend mock replay: the
 * engine runs a real match either way.
 */
// Import SDK-free pieces from built submodules so the default (mock) path never loads the
// third-party 0G compute SDK at module-load. The live-TEE provider is dynamically imported
// only when COMPUTE_PRIVATE_KEY is set (see buildProvider). Public match/player API unchanged.
import { Player } from "@turingpits/players/dist/player.js";
import { playMatch } from "@turingpits/players/dist/match.js";
import type { AttestedMatch } from "@turingpits/players/dist/match.js";
import { MockLocalProvider } from "@turingpits/players/dist/provider.js";
import { MOCK_PROVIDER_META, type ProviderMeta } from "@turingpits/players/dist/envelope.js";
import type { InferenceProvider } from "@turingpits/players/dist/types.js";
import type { GameState } from "@turingpits/engine";
import type { Persona } from "./wire.js";

/** Tribunal roster (sliced to the configured seat count; seat count itself is dynamic). */
const ROSTER: Omit<Persona, "seat">[] = [
  { name: "Oracle", blurb: "keeps her counsel" },
  { name: "Vesper", blurb: "the patient watcher" },
  { name: "Atlas", blurb: "loud, certain" },
  { name: "Nova", blurb: "young, quick to trust" },
  { name: "Kestrel", blurb: "sharp-eyed, restless" },
  { name: "Mira", blurb: "measured, watchful" },
  { name: "Juno", blurb: "calm under fire" },
];

export function buildPersonas(n: number): Persona[] {
  return Array.from({ length: n }, (_, seat) => ({ seat, ...(ROSTER[seat % ROSTER.length]!) }));
}

export interface ProviderBundle {
  provider: InferenceProvider;
  isMock: boolean;
  /** Address registered on-chain as the match's teeSigner. */
  teeSigner: string;
  /** Envelope metadata to register at createMatch — MUST equal what the provider signs with. */
  providerMeta: ProviderMeta;
}

export async function buildProvider(): Promise<ProviderBundle> {
  const computeKey = process.env.COMPUTE_PRIVATE_KEY;
  const providerAddress = process.env.COMPUTE_PROVIDER_ADDRESS;
  if (computeKey && providerAddress) {
    const { createZeroGDirectProvider } = await import("@turingpits/players/dist/zerog.js");
    const provider = await createZeroGDirectProvider({
      privateKey: computeKey,
      rpcUrl: process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai",
      providerAddress,
    });
    // The live provider signs under a known registered signer.
    const teeSigner = process.env.TEE_SIGNER_ADDRESS ?? "0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF";
    // Use the provider's REAL probed envelope meta (real tlsFingerprint), not the mock placeholder.
    if (!provider.meta) throw new Error("live provider meta was not captured at setup");
    return { provider, isMock: false, teeSigner, providerMeta: provider.meta };
  }
  // Offline-capable, credentials-free: a real local key (labeled MOCK-local).
  const mock = new MockLocalProvider(process.env.MOCK_TEE_PRIVATE_KEY);
  return { provider: mock, isMock: true, teeSigner: mock.signerAddress, providerMeta: MOCK_PROVIDER_META };
}

/** Mock provider metadata (offline path). Live matches register the provider's probed meta. */
export const PROVIDER_META = MOCK_PROVIDER_META;

export interface RunArgs {
  seed: string;
  n: number;
  nonce: string;
  personas: Persona[];
  provider: InferenceProvider;
  onTurn: (turn: import("@turingpits/players/dist/match.js").RecordedTurn, state: GameState) => Promise<void>;
  /** Public day-deliberation hook, fired per unsigned discussion contribution before the vote. */
  onDiscussion?: (entry: import("@turingpits/players/dist/match.js").DiscussionEntry, state: GameState) => Promise<void>;
}

export function runMatch(args: RunArgs): Promise<AttestedMatch> {
  const players = Array.from({ length: args.n }, () => new Player(args.provider));
  return playMatch({
    seed: args.seed,
    n: args.n,
    nonce: args.nonce,
    personas: args.personas,
    players,
    onTurn: args.onTurn,
    onDiscussion: args.onDiscussion,
  });
}
