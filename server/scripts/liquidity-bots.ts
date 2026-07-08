/**
 * Liquidity bots — # MOCK demo liquidity for the AI-Mafia markets.
 *
 * A small fleet of scripted wallets that keep a LIVING order book across every AI-Mafia market for the
 * whole match. Not a one-shot seed: each bot re-bets on its own randomized cadence right through play, so
 * the book keeps churning instead of freezing after one pass. Crucially the flow is IMBALANCED — each
 * market carries a fleet "lean" (a favored outcome most stakes flow toward) so its *percentage* actually
 * moves, not just its pot; the lean flips on a timer (push onto one side → correct toward the current
 * underdog → push somewhere else), so the odds visibly swing and then settle back. And the flow tracks the
 * DRAMA: it reacts to the orchestrator's beats (read from the read-only `GET /status`, which never starts a
 * match) and to which round-market just opened on-chain — when the story floats a new "who hangs?" /
 * "who dies tonight?" market, the bots pile a strong push onto it so its numbers swing on the beat.
 *
 * Every bet is a REAL on-chain `betProp` in the CHIP `MockBetToken` — the same categorical
 * pools/payouts/fees/settlement the frontend uses. The only "fake" parts are that the stakers are scripts
 * (not people) betting test money, and — since the bots can't see WHICH seat the table is turning on from
 * chain alone — the swung outcome is picked heuristically (# MOCK drama sync). The POINT is the spotlighted
 * market MOVING in sync with the story, then correcting. Every market (the Faction one included) is one
 * categorical prop; there is no separate betYes/betNo path.
 *
 * GASLESS: every write (faucet + approve + bet) is submitted as an EIP-2771 meta-transaction through
 * the deployed relayer, which pays the 0G gas. The bot wallets sign off-chain (free) and stay the
 * on-chain bettor (`_msgSender()` resolves to them), so pools/claims belong to the bots — but the
 * bots need ZERO native 0G. See server/src/relayer.ts and contracts/Forwarder.sol.
 *
 * Run from the repo root:
 *   npx tsx server/scripts/liquidity-bots.ts
 * or from server/:
 *   npm run bots
 *
 * Wallets (pick one; NONE need native 0G — the relayer sponsors gas):
 *   - BOT_PRIVATE_KEYS="0xabc...,0xdef..."   explicit comma-separated keys, OR
 *   - BOT_MNEMONIC="word word ..." + BOT_COUNT=4   derive N from one seed phrase, OR
 *   - nothing → N random wallets are generated, saved to server/.liquidity-bots.json (gitignored)
 *     and REUSED on the next run.
 *
 * CHIP is free: each bot mints test CHIP via a relayed faucet() when it runs low, and relays a
 * one-time max-approve so the market can pull its stakes.
 *
 * Tunables (env, all optional):
 *   RELAYER_URL                        relayer base URL (default the deployed Railway relayer); also the
 *                                      host of the read-only /status beat feed the bots react to.
 *   ZEROG_RPC_URL, ZEROG_CHAIN_ID, MAFIA_MARKET_ADDRESS, BET_TOKEN_ADDRESS
 *   BOT_MIN_BET=10  BOT_MAX_BET=50     per-wager CHIP range
 *   BOT_BET_STEP=5                     snap wagers to whole increments (→ 10, 15, 20, …, 50); 0 = off
 *   BOT_YES_PROB=0.5                   the headline Faction market's opening tilt toward MAFIA over TOWN
 *   BOT_BET_PROPS=true                 also churn every side market (default on; false = Faction only)
 *   BOT_POLL_MS=2000                   how often to scan for open matches, due bettors, and new markets
 *   BOT_BACKFILL_WINDOW=10             how many recent matches to consider at startup
 *   BOT_REBET_MIN_MS=3500              per-bot re-bet cadence — each bot waits a random span in
 *   BOT_REBET_MAX_MS=9000               [MIN, MAX] between its wagers, so the fleet keeps the book churning
 *                                      (tuned to the relayer's ~1 bet/6s-per-address refill; the fleet bets
 *                                      CONCURRENTLY, so total throughput scales with BOT_COUNT, not cadence)
 *   BOT_WAVE_MIN_MS=10000             how long a market holds one lean before the wave re-rolls
 *   BOT_WAVE_MAX_MS=24000              (push ↔ correct); a random span in [MIN, MAX] per market
 *   BOT_LEAN_STRENGTH=0.6            probability a wave's stake backs the favored outcome (the imbalance
 *                                      that moves the %); higher = sharper odds swings, 0 = no movement
 *   BOT_HOT_BIAS=0.6                  chance a due bot targets the currently-spotlighted round-market
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  MaxUint256,
  Mnemonic,
  HDNodeWallet,
  Wallet,
  formatEther,
  getAddress,
  parseEther,
} from "ethers";

// ---------- config ----------
const __dirname = dirname(fileURLToPath(import.meta.url));
// Load the repo-root .env (same one the server reads), regardless of cwd — before reading any var.
loadEnv({ path: resolve(__dirname, "..", "..", ".env") });
const WALLET_FILE = resolve(__dirname, "..", ".liquidity-bots.json");

const RPC_URL = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const CHAIN_ID = Number(process.env.ZEROG_CHAIN_ID ?? 16602);
// Deployed relayer that sponsors gas for the bots' meta-transactions (and hosts the /status beat feed).
const RELAYER_URL = (process.env.RELAYER_URL ?? "https://turingpits-production.up.railway.app").replace(/\/$/, "");
const MIN_BET = parseEther(process.env.BOT_MIN_BET ?? "10");
const MAX_BET = parseEther(process.env.BOT_MAX_BET ?? "50");
// Wagers snap to whole increments of this above MIN_BET, so a bet is one of {MIN, MIN+STEP, …, MAX}
// (defaults → 10, 15, 20, …, 50 CHIP). Set 0 to disable snapping (any amount in range).
const BET_STEP = parseEther(process.env.BOT_BET_STEP ?? "5");
const YES_PROB = Number(process.env.BOT_YES_PROB ?? 0.5);
// Churn the side markets (PlayerFate / VotedOut / NightKill / DetectiveClaim / MafiaSeat) too, not just the
// headline Faction market. Default ON — set BOT_BET_PROPS=false for Faction-only, lighter liquidity.
const BET_PROPS = !/^(0|false|no|off)$/i.test(process.env.BOT_BET_PROPS ?? "");
// Scan cadence — how often we check for due bettors, newly-floated markets, and story beats. Kept short
// so a bot that just came due fires this poll instead of trickling out over slow 5s scans.
const POLL_MS = Number(process.env.BOT_POLL_MS ?? 2000);
const BACKFILL_WINDOW = Number(process.env.BOT_BACKFILL_WINDOW ?? 10);
// Bots bet CONCURRENTLY and each is a distinct on-chain address (its own relayer rate-bucket), so fleet
// throughput scales ~linearly with this — the main knob for "more bets on the book". Default 6 comfortably
// saturates the relayer's serialized-submit ceiling (~1 mined tx/s) at the per-address 1-bet/6s refill.
const BOT_COUNT = Math.max(1, Number(process.env.BOT_COUNT ?? 6));
// Per-bot re-bet cadence (ms) — each bot waits a random span in this range between its own wagers. Tuned
// to sit just above the relayer's per-address token-bucket refill (1 token / 6s) so a bot rides its opening
// burst then settles into the sustainable rate without spraying 429 retries; the fleet churns via COUNT.
const REBET_MIN_MS = Number(process.env.BOT_REBET_MIN_MS ?? 3500);
const REBET_MAX_MS = Number(process.env.BOT_REBET_MAX_MS ?? 9000);
// Wave lifetime (ms) — how long a market holds one lean before it re-rolls (push ↔ correct → the swing).
const WAVE_MIN_MS = Number(process.env.BOT_WAVE_MIN_MS ?? 10000);
const WAVE_MAX_MS = Number(process.env.BOT_WAVE_MAX_MS ?? 24000);
// Probability a wave's stake backs its favored outcome — the imbalance that actually moves the %. Kept
// modest by default so the odds drift and swing rather than pinning to one side.
const LEAN_STRENGTH = Math.min(0.98, Math.max(0.5, Number(process.env.BOT_LEAN_STRENGTH ?? 0.6)));
// Chance a due bettor aims at the currently-spotlighted round-market (rather than a random open one).
const HOT_BIAS = Math.min(1, Math.max(0, Number(process.env.BOT_HOT_BIAS ?? 0.6)));
const CONTRACT_MIN_BET = parseEther("0.01"); // MafiaMarket.MIN_BET
// PropKind enum (contracts/contracts/MafiaMarket.sol): PlayerFate, RoundVotedOut, NightKill,
// DetectiveClaim, MafiaSeat, Faction. The round-markets (VotedOut/NightKill) carry `param` = the round
// and are the ones the story floats mid-match, so they're what we spotlight when a beat lands.
const KIND = { PLAYER_FATE: 0, ROUND_VOTED_OUT: 1, NIGHT_KILL: 2, DETECTIVE_CLAIM: 3, MAFIA_SEAT: 4, FACTION: 5 } as const;
const KIND_NAME = ["FATE", "VOTED_OUT", "NIGHT_KILL", "DET_CLAIM", "MAFIA_SEAT", "FACTION"] as const;
const kindName = (k: number) => KIND_NAME[k] ?? `kind${k}`;
const OUTCOME_MAFIA = 1;
const OUTCOME_TOWN = 0;
// Gas forwarded to each relayed inner call — comfortably covers faucet/approve/bet, under the relayer cap.
const RELAY_GAS = 600_000n;
// When a batch of due bots fires together, offset each one slightly so they don't slam the relayer's
// verify()/submit path in a single instant — small enough that the batch still overlaps (stays parallel).
const BATCH_STAGGER_MS = 120;

// Minimal ABI surface the bots read — kept in sync with contracts/contracts/MafiaMarket.sol.
const MARKET_ABI = [
  "function nextMatchId() view returns (uint256)",
  "function betToken() view returns (address)",
  "function matches(uint256) view returns (uint8 state, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot, address teeSigner, string providerType, string providerIdentity, string tlsFingerprint, string nonce, uint8 playerCount, bytes32 transcriptCID, uint16 feeBps)",
  "function propCount(uint256 matchId) view returns (uint256)",
  "function getProp(uint256 matchId, uint256 propIdx) view returns (tuple(uint8 kind, uint8 param, uint8 numOutcomes, bool closed, uint8 state, uint8 winningOutcome, uint128 netPot, uint128 winningPool, uint128[] pools))",
  "function betProp(uint256 matchId, uint256 propIdx, uint8 outcome, uint128 amount)",
];
const TOKEN_ABI = [
  "function faucet()",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];

// Pure encoders (no provider) for building the calldata we relay.
const marketIface = new Interface(MARKET_ABI);
const tokenIface = new Interface(TOKEN_ABI);

// EIP-712 typed-data for a Forwarder ForwardRequest — mirrors frontend/src/lib/contract.ts.
const FORWARDER_TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
};

interface RelayInfo {
  enabled: boolean;
  funded: boolean;
  forwarder: string;
  market: string;
  token: string;
  relayer: string;
  chainId: number;
  relayerBalance: string;
}

/** One `getProp` result (see MARKET_ABI) — only the fields the bots read. */
type PropTuple = { kind: bigint; param: bigint; numOutcomes: bigint; closed: boolean; pools: bigint[] };

/** The lobby /status snapshot (server/src/broadcast.ts MatchStatus) — the bots' read-only beat feed. */
interface MatchStatus {
  live: boolean;
  matchId: number | null;
  round: number;
  state: string;
  bettingLive: boolean;
  pot: string;
  isMock: boolean;
}

// ---------- pure betting strategy (unit-tested in liquidity-bots.test.ts) ----------
// These are the decision core — imbalance (moves the %), wave alternation (the swing), and drama override
// (the spotlight). Kept pure over an injected `rng` so the statistics are deterministically testable
// without an RPC, a relayer, or a chain.

export type WavePhase = "push" | "correct";
export interface Lean {
  /** The outcome the fleet is currently piling onto. */
  favored: number;
  /** Probability (0..1) that a given wager backs `favored` — the imbalance that moves the %. */
  strength: number;
  phase: WavePhase;
}

/** Index of the smallest pool (the current underdog). Ties resolve to the lowest index. */
export function minPoolOutcome(pools: readonly bigint[], numOutcomes: number): number {
  let best = 0;
  let bestVal: bigint | null = null;
  for (let i = 0; i < numOutcomes; i++) {
    const v = pools[i] ?? 0n;
    if (bestVal === null || v < bestVal) {
      bestVal = v;
      best = i;
    }
  }
  return best;
}

/**
 * Pick the outcome for ONE wager: back the fleet's favored outcome with probability ≈ `lean.strength`,
 * otherwise a uniformly random outcome. A strength above 1/numOutcomes tilts the pool — repeated over a
 * wave the favored outcome's SHARE climbs (the movement); 0.5 on a 2-way market leaves it balanced.
 */
export function chooseOutcome(numOutcomes: number, lean: Lean, rng: () => number = Math.random): number {
  const n = Math.max(1, numOutcomes);
  if (rng() < lean.strength && lean.favored >= 0 && lean.favored < n) return lean.favored;
  return Math.floor(rng() * n) % n;
}

export interface NextLeanArgs {
  numOutcomes: number;
  /** Current per-outcome pools — a correction wave props up the smallest of these. */
  pools: readonly bigint[];
  /** The previous lean, so we alternate push → correct → push … */
  prev?: Lean | null;
  /**
   * A forced favored outcome (the drama spotlight / a freshly-hot round-market). When set, we hard-push
   * onto it at full strength so the spotlighted market swings on the beat, ignoring the push/correct cycle.
   */
  favoredOutcome?: number | null;
  /** Peak lean strength for a push wave (default BOT_LEAN_STRENGTH). */
  strengthMax?: number;
  rng?: () => number;
}

/**
 * Re-roll a market's lean when its wave expires (or on a beat). Alternates:
 *   - PUSH   : pile onto one outcome (fresh random target) at high strength → its share climbs.
 *   - CORRECT: after a push, back the current UNDERDOG at moderate strength → the book swings back
 *              (so it doesn't drift one way forever).
 * A `favoredOutcome` (drama) overrides the cycle with a full-strength push onto that outcome.
 */
export function nextLean(args: NextLeanArgs): Lean {
  const { numOutcomes, pools, prev } = args;
  const rng = args.rng ?? Math.random;
  const strengthMax = args.strengthMax ?? LEAN_STRENGTH;
  const n = Math.max(1, numOutcomes);
  if (args.favoredOutcome != null && args.favoredOutcome >= 0 && args.favoredOutcome < n) {
    return { favored: args.favoredOutcome, strength: strengthMax, phase: "push" };
  }
  // A push just ran → correct toward the current underdog so the gap the push opened narrows again.
  // Capped at the push strength so a correction never swings harder than the push (matters once the
  // strength knob is turned down near 0.5).
  if (prev?.phase === "push") {
    return { favored: minPoolOutcome(pools, n), strength: Math.min(strengthMax, 0.5 + 0.2 * rng()), phase: "correct" };
  }
  // Fresh push onto a random outcome (not necessarily the current leader → real, visible movement).
  return { favored: Math.floor(rng() * n) % n, strength: strengthMax - 0.15 * rng(), phase: "push" };
}

// ---------- helpers ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

/** A random wager on the {MIN_BET, MIN_BET+STEP, …, MAX_BET} grid — snapped to whole BET_STEP
 *  increments (default 5 CHIP) so pools show round numbers. In CHIP base units, clamped to the
 *  contract minimum. BET_STEP <= 0 disables snapping (any amount in [MIN_BET, MAX_BET]). */
function randomBet(): bigint {
  const span = MAX_BET > MIN_BET ? MAX_BET - MIN_BET : 0n;
  let amt: bigint;
  if (BET_STEP > 0n) {
    // steps = whole increments that fit in the span; floor keeps the top rung <= MAX_BET. randInt is
    // inclusive, so k ∈ [0, steps] covers every rung from MIN_BET up to the last one at or below MAX_BET.
    const steps = span / BET_STEP;
    const k = steps > 0n ? BigInt(randInt(0, Number(steps))) : 0n;
    amt = MIN_BET + k * BET_STEP;
  } else {
    const r = span > 0n ? (BigInt(Math.floor(Math.random() * 1e6)) * span) / 1_000_000n : 0n;
    amt = MIN_BET + r;
  }
  return amt < CONTRACT_MIN_BET ? CONTRACT_MIN_BET : amt;
}

/** For a freshly-hot round-market, land the spotlight swing on a SEAT (outcomes 0..n-2) rather than the
 *  trailing "no one" bucket (n-1), so the drama reads as the table turning on a person. */
function hotFavored(numOutcomes: number): number {
  return numOutcomes > 1 ? randInt(0, numOutcomes - 2) : 0;
}

/** GET the relayer's /relay/info. Returns null when it's absent, unreachable, or disabled. */
async function fetchRelayInfo(base: string): Promise<RelayInfo | null> {
  try {
    const res = await fetch(`${base}/relay/info`);
    if (!res.ok) return null;
    const info = (await res.json()) as RelayInfo;
    return info?.enabled ? info : null;
  } catch {
    return null;
  }
}

/** GET the read-only /status beat feed (never starts a match). Null when unreachable — the bots then
 *  fall back to purely on-chain drama cues (which round-market just opened). */
async function fetchStatus(base: string): Promise<MatchStatus | null> {
  try {
    const res = await fetch(`${base}/status`);
    if (!res.ok) return null;
    return (await res.json()) as MatchStatus;
  } catch {
    return null;
  }
}

/** Resolve the bot signing wallets from env, or generate+persist a fresh fleet (none need gas). */
function loadWallets(provider: JsonRpcProvider): Wallet[] {
  const explicit = process.env.BOT_PRIVATE_KEYS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (explicit?.length) {
    console.log(`Using ${explicit.length} bot wallet(s) from BOT_PRIVATE_KEYS.`);
    return explicit.map((pk) => new Wallet(pk, provider));
  }

  if (process.env.BOT_MNEMONIC) {
    const mn = Mnemonic.fromPhrase(process.env.BOT_MNEMONIC.trim());
    console.log(`Deriving ${BOT_COUNT} bot wallet(s) from BOT_MNEMONIC.`);
    return Array.from({ length: BOT_COUNT }, (_, i) =>
      new Wallet(HDNodeWallet.fromMnemonic(mn, `m/44'/60'/0'/0/${i}`).privateKey, provider),
    );
  }

  // No keys provided: reuse the saved fleet, TOPPING UP to BOT_COUNT if it has fewer. Existing keys
  // are never discarded — we only ever append. Lowering BOT_COUNT keeps every saved wallet; raising
  // it appends fresh ones. (Gas is sponsored by the relayer, so no wallet needs funding.)
  const existing: string[] = existsSync(WALLET_FILE) ? JSON.parse(readFileSync(WALLET_FILE, "utf8")).keys : [];
  const keys = [...existing];
  const added = Math.max(0, BOT_COUNT - keys.length);
  for (let i = 0; i < added; i++) keys.push(Wallet.createRandom().privateKey);
  if (added > 0 || !existsSync(WALLET_FILE)) {
    writeFileSync(WALLET_FILE, JSON.stringify({ keys }, null, 2));
  }
  if (existing.length && added > 0) {
    console.log(`Reusing ${existing.length} saved bot wallet(s) and adding ${added} new → ${WALLET_FILE}.`);
  } else if (existing.length) {
    console.log(`Reusing ${keys.length} saved bot wallet(s) from ${WALLET_FILE}.`);
  } else {
    console.log(`Generated ${keys.length} bot wallet(s) → ${WALLET_FILE} (gitignored).`);
  }
  return keys.map((pk) => new Wallet(pk, provider));
}

// ---------- main ----------
async function main() {
  const relay = await fetchRelayInfo(RELAYER_URL);
  if (!relay) {
    console.error(`Relayer at ${RELAYER_URL} is not reachable or not enabled (GET /relay/info). Aborting.`);
    console.error("Set RELAYER_URL to a live gasless relayer, or start server/src/relayer.ts.");
    process.exit(1);
  }
  if (!relay.funded) {
    console.warn(`⚠️  Relayer reports funded:false (balance ${relay.relayerBalance} 0G) — relays will fail until it's topped up.`);
  }

  // The relayer only sponsors calls to ITS market + token, so bet against exactly those addresses.
  const marketAddr = getAddress(relay.market);
  const envMarket = process.env.MAFIA_MARKET_ADDRESS;
  if (envMarket && getAddress(envMarket) !== marketAddr) {
    console.warn(`⚠️  MAFIA_MARKET_ADDRESS (${envMarket}) differs from the relayer's market (${marketAddr}); using the relayer's.`);
  }

  const provider = new JsonRpcProvider(RPC_URL, relay.chainId ?? CHAIN_ID);
  const wallets = loadWallets(provider);
  const market = new Contract(marketAddr, MARKET_ABI, provider); // read-only (writes go via the relayer)
  const tokenAddr = getAddress(process.env.BET_TOKEN_ADDRESS ?? relay.token ?? (await market.betToken()));
  const forwarder = new Contract(relay.forwarder, ["function getNonce(address) view returns (uint256)"], provider);
  const domain = { name: "TuringPitsForwarder", version: "1", chainId: relay.chainId, verifyingContract: relay.forwarder };

  console.log("─".repeat(60));
  console.log("Liquidity bots — MOCK living order book (real on-chain CHIP wagers, gasless via relayer)");
  console.log(`  RPC      : ${RPC_URL} (chain ${relay.chainId})`);
  console.log(`  Relayer  : ${RELAYER_URL}  (wallet ${relay.relayer}, ${relay.relayerBalance} 0G${relay.funded ? "" : " ⚠️ OUT OF GAS"})`);
  console.log(`  Forwarder: ${relay.forwarder}`);
  console.log(`  Market   : ${marketAddr}`);
  console.log(`  CHIP     : ${tokenAddr}`);
  console.log(`  Bet range: ${formatEther(MIN_BET)}–${formatEther(MAX_BET)} CHIP, Faction tilt ${YES_PROB}`);
  console.log(`  Book     : ${BET_PROPS ? "Faction + all side markets" : "Faction only"}  lean ${LEAN_STRENGTH}  rebet ${REBET_MIN_MS}-${REBET_MAX_MS}ms  wave ${WAVE_MIN_MS}-${WAVE_MAX_MS}ms  poll ${POLL_MS}ms`);
  for (const w of wallets) console.log(`  bot ${w.address}  (gas sponsored by relayer)`);
  console.log("─".repeat(60));

  /**
   * Sign a ForwardRequest for `to`+`data` and POST it to the relayer, which submits it on-chain and
   * pays gas. Resolves once the inner tx is mined. Retries transient rate-limits; throws on rejection.
   */
  async function relayCall(bot: Wallet, to: string, data: string): Promise<string> {
    const from = bot.address;
    const nonce = (await forwarder.getFunction("getNonce")(from)) as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const message = { from, to, value: 0n, gas: RELAY_GAS, nonce, deadline, data };
    const signature = await bot.signTypedData(domain, FORWARDER_TYPES, message);
    // Serialize the bigints as strings for JSON; the relayer parses them back with BigInt(...).
    const request = {
      from,
      to,
      value: "0",
      gas: RELAY_GAS.toString(),
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      data,
    };
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${RELAYER_URL}/relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request, signature }),
      });
      // 429 = per-`from` rate limit / in-flight lock; the request is still valid (nonce unchanged), retry it.
      if (res.status === 429 && attempt < 4) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as { txHash?: string; error?: string };
      if (res.status === 503) throw new Error(`relayer out of gas — ${body.error ?? "top it up"}`);
      if (!res.ok) throw new Error(body.error ?? `relay failed (${res.status})`);
      // The relayer only responds AFTER awaiting the receipt (server/src/relayer.ts: `enqueue(… tx.wait())`),
      // so the inner tx is already mined here — no second client-side waitForTransaction (a wasted round-trip
      // that used to serialize the whole fleet behind each bet).
      return body.txHash ?? "";
    }
  }

  const token = new Contract(tokenAddr, TOKEN_ABI, provider); // read-only balance/allowance checks

  // Bots whose max-approve has landed — the MaxUint256 allowance is permanent, so we never re-read it.
  const approved = new Set<string>();

  /** Ensure a bot can stake: relay a faucet() when CHIP is low, then a one-time max-approve. */
  async function prepare(bot: Wallet, amount: bigint): Promise<void> {
    // Balance + allowance are independent reads → fetch together. Skip the allowance read entirely once the
    // bot's max-approve is known to have landed (it can only ever be >= amount after that).
    const needAllowanceRead = !approved.has(bot.address);
    const [bal, allowance] = await Promise.all([
      token.balanceOf(bot.address) as Promise<bigint>,
      needAllowanceRead ? (token.allowance(bot.address, marketAddr) as Promise<bigint>) : Promise.resolve(MaxUint256),
    ]);
    if (bal < amount) {
      await relayCall(bot, tokenAddr, tokenIface.encodeFunctionData("faucet", []));
    }
    if (allowance < amount) {
      await relayCall(bot, tokenAddr, tokenIface.encodeFunctionData("approve", [marketAddr, MaxUint256]));
    }
    approved.add(bot.address); // allowance is now >= amount (max-approve is permanent) — cache it
  }

  // ── living-book state (persists across polls) ──────────────────────────────────────────────────
  interface PropRec { kind: number; numOutcomes: number; lean: Lean; nextRerollAt: number; seeded: boolean }
  const propState = new Map<string, PropRec>(); // key `m{matchId}p{idx}` → current wave for that market
  const nextBetAt = wallets.map(() => 0); // per-bot wall-clock (ms) at which each bot may bet again
  let lastHotKey: string | null = null; // the round-market currently spotlighted (so a NEW one re-swings)
  let lastLiveMatch = -1; // the /status match we're tracking beats for
  let lastLiveRound = 0; // its highest seen round (a bump = a story beat → stir the whole book)

  /** Build a market's opening lean, or re-roll it when its wave expires / a beat forces a stir. */
  function refreshLean(key: string, kind: number, numOutcomes: number, pools: bigint[], stir: boolean): PropRec {
    const now = Date.now();
    let rec = propState.get(key);
    if (!rec) {
      // Faction opens with the configured MAFIA/TOWN tilt; every other market starts on a fresh push.
      const lean: Lean = kind === KIND.FACTION
        ? { favored: Math.random() < YES_PROB ? OUTCOME_MAFIA : OUTCOME_TOWN, strength: LEAN_STRENGTH, phase: "push" }
        : nextLean({ numOutcomes, pools });
      rec = { kind, numOutcomes, lean, nextRerollAt: now + randInt(WAVE_MIN_MS, WAVE_MAX_MS), seeded: false };
      propState.set(key, rec);
      return rec;
    }
    if (stir || now >= rec.nextRerollAt) {
      rec.lean = nextLean({ numOutcomes, pools, prev: rec.lean });
      rec.nextRerollAt = now + randInt(WAVE_MIN_MS, WAVE_MAX_MS);
    }
    return rec;
  }

  /**
   * One pass over a live match: read every prop's shape+pools, refresh the OPEN ones' waves, spotlight the
   * latest-round market on a beat, then let every DUE bot place one wager (biased toward the hot market).
   * @param stir true when a /status beat just advanced this match's round — re-roll every wave now.
   */
  async function tickMatch(matchId: number, deadlineBlock: bigint, stir: boolean) {
    let count = 0;
    try {
      count = Number((await market.propCount(matchId)) as bigint);
    } catch {
      return; // transient RPC read; retry next poll
    }

    // Read every prop's shape+pools in ONE parallel batch (was a sequential RPC round-trip per prop).
    const propReads = await Promise.all(
      Array.from({ length: count }, (_, propIdx) =>
        (market.getProp(matchId, propIdx) as Promise<PropTuple>).then(
          (pr) => ({ propIdx, pr }),
          () => null, // transient read → skip this prop this poll
        ),
      ),
    );

    const open: { key: string; propIdx: number; rec: PropRec }[] = [];
    let hotKey: string | null = null;
    let hotParam = -1;
    for (const entry of propReads) {
      if (!entry) continue;
      const { propIdx, pr } = entry;
      const kind = Number(pr.kind);
      if (kind !== KIND.FACTION && !BET_PROPS) continue; // Faction-only mode
      const key = `m${matchId}p${propIdx}`;
      if (pr.closed) {
        propState.delete(key); // frozen — outcome is public, nothing left to bet
        continue;
      }
      const numOutcomes = Number(pr.numOutcomes);
      const pools = (pr.pools ?? []).map((x) => BigInt(x));
      // The hot market = the highest-round OPEN round-market — i.e. the "who hangs?" / "who dies tonight?"
      // the story just floated. That's the one whose numbers should swing on the beat.
      const param = Number(pr.param);
      if ((kind === KIND.ROUND_VOTED_OUT || kind === KIND.NIGHT_KILL) && param > hotParam) {
        hotParam = param;
        hotKey = key;
      }
      open.push({ key, propIdx, rec: refreshLean(key, kind, numOutcomes, pools, stir) });
    }
    if (open.length === 0) return;

    // A NEW round-market just took the spotlight → hard-push its odds onto a seat right now, so the
    // market moves visibly on the beat. (# MOCK drama sync: chain reads can't reveal WHICH seat the
    // table is turning on, so the swung seat is heuristic; the synced MOVEMENT is the effect.)
    if (hotKey && hotKey !== lastHotKey) {
      const hot = open.find((o) => o.key === hotKey);
      if (hot) {
        hot.rec.lean = { favored: hotFavored(hot.rec.numOutcomes), strength: LEAN_STRENGTH, phase: "push" };
        hot.rec.nextRerollAt = Date.now() + randInt(WAVE_MIN_MS, WAVE_MAX_MS);
        console.log(`★ m${matchId} p${hot.propIdx} [${kindName(hot.rec.kind)}] spotlight — swinging odds toward #${hot.rec.lean.favored}`);
      }
      lastHotKey = hotKey;
    }

    // Every bot whose cadence has elapsed places ONE wager this pass — the churn. The whole due batch
    // fires CONCURRENTLY: each bot is a distinct on-chain `from`, so the relayer's per-`from` in-flight
    // lock never blocks one bot behind another, and it serializes the actual submissions internally
    // (nonce-safe). Running them in parallel means a whole batch lands in about the time ONE bet used to
    // take — instead of N bets back-to-back with a 200-700ms gap between each.
    const now = Date.now();
    const dueBots = wallets.map((_, i) => i).filter((i) => now >= nextBetAt[i]!);
    if (dueBots.length === 0) return;

    await Promise.allSettled(
      dueBots.map(async (i, slot) => {
        // Reserve the bot's next slot UP FRONT so an in-flight bet isn't double-scheduled by the next poll
        // (which can fire before this relay round-trip resolves).
        nextBetAt[i] = now + randInt(REBET_MIN_MS, REBET_MAX_MS);
        // Light stagger so a full batch doesn't hit the relayer in one instant — still overlaps (parallel).
        if (slot > 0) await sleep(slot * BATCH_STAGGER_MS + randInt(0, 80));

        // Target: bias toward the spotlighted market, else a random open one, so no market goes empty.
        let target = open[randInt(0, open.length - 1)]!;
        if (hotKey && Math.random() < HOT_BIAS) {
          const h = open.find((o) => o.key === hotKey);
          if (h) target = h;
        }
        const { numOutcomes } = target.rec;
        // A brand-new market's first bet goes to a uniformly random outcome so the book opens SPREAD across
        // outcomes (not all stacked on the lean); the imbalanced waves take over once it's seeded.
        const outcome = target.rec.seeded ? chooseOutcome(numOutcomes, target.rec.lean) : randInt(0, numOutcomes - 1);
        const bot = wallets[i]!;
        const amount = randomBet();
        try {
          await prepare(bot, amount);
          // The host may closeProp this market (freeze-before-reveal) or the settlement deadline may lapse
          // while prepare()'s faucet/approve was in flight — re-check right before staking so we don't relay
          // a doomed bet that reverts "prop closed"/"betting closed".
          if (BigInt(await provider.getBlockNumber()) > deadlineBlock) return;
          const data = marketIface.encodeFunctionData("betProp", [matchId, target.propIdx, outcome, amount]);
          await relayCall(bot, marketAddr, data);
          target.rec.seeded = true;
          const label = target.rec.kind === KIND.FACTION ? (outcome === OUTCOME_MAFIA ? "MAFIA" : "TOWN") : `#${outcome}`;
          console.log(
            `✓ m${matchId} p${target.propIdx} [${kindName(target.rec.kind)}] bot ${i} ${formatEther(amount)} CHIP → ${label}` +
              ` (${target.rec.lean.phase} lean #${target.rec.lean.favored}@${target.rec.lean.strength.toFixed(2)})`,
          );
        } catch (e) {
          console.warn(`✗ m${matchId} p${target.propIdx} bot ${i} — ${(e as Error).message.split("\n")[0]}`);
        }
      }),
    );
  }

  console.log("Watching for open matches… living order book active  (Ctrl-C to stop)\n");
  for (;;) {
    // React to the orchestrator's beats via the read-only /status (never starts a match): when the live
    // match advances a round, STIR its whole book so every market's odds move on the story beat.
    let stirMatch = -1;
    const status = await fetchStatus(RELAYER_URL);
    if (status?.live && status.matchId != null) {
      if (status.matchId !== lastLiveMatch) {
        lastLiveMatch = status.matchId;
        lastLiveRound = 0;
        lastHotKey = null;
      }
      if (status.round > lastLiveRound) {
        stirMatch = status.matchId;
        lastLiveRound = status.round;
        console.log(`↷ beat: match ${status.matchId} round ${status.round} — stirring the book`);
      }
    }

    try {
      const next = Number((await market.nextMatchId()) as bigint);
      const from = Math.max(0, next - BACKFILL_WINDOW);
      const ids = Array.from({ length: next - from }, (_, k) => from + k);
      // Read the current block once + every backfill match's state in ONE parallel batch (was a sequential
      // matches() read per id AND a redundant getBlockNumber inside the loop).
      const [block, metas] = await Promise.all([
        provider.getBlockNumber().then((b) => BigInt(b)),
        Promise.all(ids.map((id) => market.matches(id).then((m) => ({ id, m })))),
      ]);
      for (const { id, m } of metas) {
        if (Number(m.state) !== 1) continue; // 1 == Created; betProp reverts "not open" in any other state
        if (block < BigInt(m.bettingOpenBlock)) continue; // betting hasn't opened yet
        // Bet through the WHOLE match, up to settlementDeadlineBlock — NOT bettingCloseBlock. There is no
        // lock step: the match stays Created and betProp is accepted until the settlement deadline, and the
        // short-lived in-loop markets open mid-play AFTER bettingCloseBlock, so gating there would miss them.
        const deadlineBlock = BigInt(m.settlementDeadlineBlock);
        if (block > deadlineBlock) continue; // past the on-chain cutoff — betProp would revert "betting closed"
        await tickMatch(id, deadlineBlock, stirMatch === id);
      }
    } catch (e) {
      console.warn(`poll error — ${(e as Error).message.split("\n")[0]}`);
    }
    await sleep(POLL_MS);
  }
}

// Run the loop only when invoked directly (`tsx scripts/liquidity-bots.ts`), so importing this module for
// its pure strategy exports (e.g. from liquidity-bots.test.ts) does NOT start betting.
const invokedDirectly = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
