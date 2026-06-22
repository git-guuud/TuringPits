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
  { name: "Atlas", blurb: "loud and certain; blunt one-line verdicts, no hedging" },
  { name: "Vesper", blurb: "dry and wry; speaks in understatement and pointed questions" },
  { name: "Nova", blurb: "earnest and eager; warm, open, thinks out loud" },
  { name: "Kestrel", blurb: "sharp and restless; quick, clipped sentences" },
  { name: "Mira", blurb: "measured and even; weighs both sides aloud before landing" },
  { name: "Juno", blurb: "calm and plainspoken; unhurried and hard to rattle" },
  { name: "Oracle", blurb: "sparing and cryptic; short, weighty, riddling lines" },
  { name: "Cassius", blurb: "formal and precise; makes one careful, lawyerly point" },
  { name: "Pip", blurb: "chatty and breezy; light, a little joking, disarming" },
  { name: "Rook", blurb: "terse and grim; few words, and heavy ones" },
  { name: "Lark", blurb: "bright and quick; upbeat, hopeful phrasing" },
  { name: "Sable", blurb: "cool and cynical; distrusts the easy answer" },
  { name: "Bram", blurb: "gruff and direct; no patience for waffle" },
  { name: "Odette", blurb: "poised and precise; deliberate, exact word choice" },
  { name: "Flint", blurb: "fiery and pushy; presses hard to force a decision" },
  { name: "Wren", blurb: "soft-spoken and steady; gentle, careful phrasing" },
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
      providerAddress,
      // Token pacing is OPT-IN and off by default: the provider enforces only 10 requests/min (no
      // token cap — rate-probe confirmed), so the request throttle alone paces. Set TOKENS_PER_MIN
      // only if a real token limit ever surfaces.
      ...(process.env.TOKENS_PER_MIN ? { tokensPerMin: Number(process.env.TOKENS_PER_MIN) } : {}),
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
  });
}
