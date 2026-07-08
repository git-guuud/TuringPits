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
import { createHash } from "node:crypto";
import { Player } from "@turingpits/players/dist/player.js";
import { playMatch } from "@turingpits/players/dist/match.js";
import type { AttestedMatch } from "@turingpits/players/dist/match.js";
import { MockLocalProvider } from "@turingpits/players/dist/provider.js";
import { MOCK_PROVIDER_META, type ProviderMeta } from "@turingpits/players/dist/envelope.js";
import type { InferenceProvider } from "@turingpits/players/dist/types.js";
import type { GameState } from "@turingpits/engine";
import type { Persona } from "./wire.js";

/**
 * Tribunal persona pool. A match draws a RANDOM subset of these (one per seat), so the cast — and
 * the table's mix of voices — changes from match to match instead of always being the first N in
 * order. Each `blurb` is a concrete SPEAKING STYLE (manner, tone, sentence shape), not a vague
 * trait: the live model is effectively greedy and otherwise collapses every seat to the same
 * wording, so a distinct voice per seat is what actually makes them diverge. The blurb doubles as
 * the seat's flavor line in the UI. Kept free of "reads/tells/observes" language so it steers HOW a
 * seat talks without inviting it to fabricate behaviour it never saw. Pool size comfortably exceeds
 * the max seat count (8) so a match never has to repeat a persona.
 */
const ROSTER: Omit<Persona, "seat">[] = [
  { name: "Atlas", blurb: "thunderous and absolute; hurls one-line verdicts like a gavel and dares you to argue" },
  { name: "Vesper", blurb: "dry and lethal; needles with silky understatement and questions that draw blood" },
  { name: "Nova", blurb: "burning-earnest; pleads, hopes aloud, and takes every betrayal to heart" },
  { name: "Kestrel", blurb: "restless and razor-quick; fires clipped, staccato jabs and never sits still" },
  { name: "Mira", blurb: "coolly judicial; weighs both sides aloud, then brings the hammer down hard" },
  { name: "Juno", blurb: "unshakable and plainspoken; slow to anger, impossible to rattle, deadly once set" },
  { name: "Oracle", blurb: "cryptic and grave; drops short, riddling lines that land like prophecy" },
  { name: "Cassius", blurb: "icy and lawyerly; builds one airtight, merciless argument and closes the case" },
  { name: "Pip", blurb: "breezy and mischievous; jokes, charms, and slips the knife in while you're laughing" },
  { name: "Rook", blurb: "grim and sparing; a few heavy words that shut the room up" },
  { name: "Lark", blurb: "bright and rallying; rousing, upbeat, forever calling the table to a banner" },
  { name: "Sable", blurb: "cynical and cutting; sneers at the easy answer and trusts nobody's word" },
  { name: "Bram", blurb: "gruff and bulldozing; no patience for waffle, demands you get to the point" },
  { name: "Odette", blurb: "poised and glacial; exact, deliberate, and withering when crossed" },
  { name: "Flint", blurb: "hot-tempered and relentless; slams the table and drives everyone toward a verdict" },
  { name: "Wren", blurb: "soft-voiced but steel-spined; gentle phrasing wrapped around an unyielding read" },
];

/** Deterministic PRNG (mulberry32) seeded from a string — same match seed → same cast, so persona
 *  casting is reproducible alongside roles, yet varies across matches as the seed does. */
function seededRng(seedStr: string): () => number {
  let a = createHash("sha256").update(seedStr).digest().readUInt32BE(0) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cast `n` seats from a SHUFFLED copy of the pool, so each match gets a different, distinct set of
 * personas. Seeded by the match seed when given (reproducible with roles); otherwise truly random.
 */
export function buildPersonas(n: number, seed?: string): Persona[] {
  const pool = [...ROSTER];
  const rng = seed ? seededRng(seed) : Math.random;
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return Array.from({ length: n }, (_, seat) => ({ seat, ...pool[seat % pool.length]! }));
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
      // Thread the compute chainId so a mainnet RPC (16661) isn't queried with the testnet default
      // (16602) — ethers would mismatch the network and every call would fail. Unset →
      // createZeroGDirectProvider keeps its Galileo-testnet (16602) fallback, so the default
      // testnet path is unchanged. (MOVEOVER.md Step 2a.)
      ...(process.env.COMPUTE_CHAIN_ID ? { chainId: Number(process.env.COMPUTE_CHAIN_ID) } : {}),
      providerAddress,
      // Token pacing is OPT-IN and off by default: the provider enforces only 10 requests/min (no
      // token cap — rate-probe confirmed), so the request throttle alone paces. Set TOKENS_PER_MIN
      // only if a real token limit ever surfaces.
      ...(process.env.TOKENS_PER_MIN ? { tokensPerMin: Number(process.env.TOKENS_PER_MIN) } : {}),
    });
    // Register the signer the provider ACTUALLY signs with — its probed `status.teeSignerAddress`,
    // captured at setup as `provider.teeSignerAddress`. NOT a hardcoded/env address: any mismatch
    // makes settle() revert "bad TEE signature". Using the probed value is chain-agnostic (works
    // verbatim for testnet AND mainnet providers) and removes the trap of a stale testnet
    // TEE_SIGNER_ADDRESS lingering in .env after a mainnet switch. (MOVEOVER.md Step 2b.)
    const teeSigner = provider.teeSignerAddress;
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
  /** Nightfall hook (before any night action) — opens the "who dies tonight?" betting window. */
  onNightfall?: (round: number, state: GameState) => Promise<void>;
  /** Pre-vote hook (after the discussion pass) — opens the "who hangs this round?" betting window. */
  onPreVote?: (round: number, state: GameState) => Promise<void>;
}

/**
 * How many extra times to resample a signed-decision (or reason) inference whose output isn't
 * usable, before giving up. parseDecision requires byte-identical canonical JSON, which a live
 * model occasionally misses; with 0 retries a SINGLE such miss anywhere in a multi-round match
 * throws and the whole match is abandoned (left unsettled → swept into RefundMode). A match has
 * many signed decisions, so even a modest per-attempt miss rate compounds into most matches
 * abandoning. Each retry costs one throttled inference call ONLY on failure (the loop breaks on
 * first success), so this trades a little worst-case time for a large drop in abandonment.
 */
const DECISION_RETRIES = Math.max(0, Number(process.env.DECISION_RETRIES ?? 3));

export function runMatch(args: RunArgs): Promise<AttestedMatch> {
  const players = Array.from({ length: args.n }, () => new Player(args.provider, { decisionRetries: DECISION_RETRIES }));
  return playMatch({
    seed: args.seed,
    n: args.n,
    nonce: args.nonce,
    personas: args.personas,
    players,
    onTurn: args.onTurn,
    onDiscussion: args.onDiscussion,
    onNightfall: args.onNightfall,
    onPreVote: args.onPreVote,
  });
}
