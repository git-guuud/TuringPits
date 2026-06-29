/**
 * Liquidity bots — # MOCK demo liquidity for the AI-Mafia markets.
 *
 * A small fleet of scripted wallets that watch the deployed `MafiaMarket` for newly-opened matches
 * and sprinkle small CHIP wagers on both sides (and, optionally, the per-seat survival side markets)
 * so the betting UI isn't an empty book when a human first lands on it. Every bet is a REAL on-chain
 * `betYes/betNo` (approve + transferFrom) in the CHIP `MockBetToken` — the same path the frontend
 * uses — so the pools, payouts, fees and settlement stay genuine. The only "fake" part is that the
 * stakers are scripts, not people, betting test money with no value.
 *
 * Run from the repo root:
 *   npx tsx server/scripts/liquidity-bots.ts
 * or from server/:
 *   npm run bots
 *
 * Wallets (pick one; each must hold native 0G for gas — fund at https://faucet.0g.ai):
 *   - BOT_PRIVATE_KEYS="0xabc...,0xdef..."   explicit comma-separated keys, OR
 *   - BOT_MNEMONIC="word word ..." + BOT_COUNT=4   derive N from one seed phrase, OR
 *   - nothing → N random wallets are generated, saved to server/.liquidity-bots.json (gitignored)
 *     and REUSED on the next run. Their addresses are printed — fund them once with testnet 0G.
 *
 * CHIP is free: each bot mints test CHIP via the token faucet() when it runs low. Gas is native 0G
 * and is NOT auto-funded — if a bot has 0 native balance it is skipped with a clear warning.
 *
 * Tunables (env, all optional):
 *   ZEROG_RPC_URL, ZEROG_CHAIN_ID, MAFIA_MARKET_ADDRESS, BET_TOKEN_ADDRESS
 *   BOT_MIN_BET=0.5  BOT_MAX_BET=5     per-wager CHIP range
 *   BOT_YES_PROB=0.5                   chance a bot picks YES (Mafia-win) over NO
 *   BOT_BET_PROPS=false                also place a few bets on survival side markets
 *   BOT_POLL_MS=8000                   how often to scan for new/open matches
 *   BOT_BACKFILL_WINDOW=10             how many recent matches to consider at startup
 *   BOT_MAX_BETS_PER_MATCH=1           bets each bot places per match (per market)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import {
  Contract,
  JsonRpcProvider,
  MaxUint256,
  Mnemonic,
  HDNodeWallet,
  Wallet,
  formatEther,
  parseEther,
} from "ethers";

// ---------- config ----------
const __dirname = dirname(fileURLToPath(import.meta.url));
// Load the repo-root .env (same one the server reads), regardless of cwd — before reading any var.
loadEnv({ path: resolve(__dirname, "..", "..", ".env") });
const WALLET_FILE = resolve(__dirname, "..", ".liquidity-bots.json");

const RPC_URL = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const CHAIN_ID = Number(process.env.ZEROG_CHAIN_ID ?? 16602);
const MARKET_ADDRESS = process.env.MAFIA_MARKET_ADDRESS;
const MIN_BET = parseEther(process.env.BOT_MIN_BET ?? "0.5");
const MAX_BET = parseEther(process.env.BOT_MAX_BET ?? "5");
const YES_PROB = Number(process.env.BOT_YES_PROB ?? 0.5);
const BET_PROPS = /^(1|true|yes)$/i.test(process.env.BOT_BET_PROPS ?? "");
const POLL_MS = Number(process.env.BOT_POLL_MS ?? 8000);
const BACKFILL_WINDOW = Number(process.env.BOT_BACKFILL_WINDOW ?? 10);
const MAX_BETS_PER_MATCH = Math.max(1, Number(process.env.BOT_MAX_BETS_PER_MATCH ?? 1));
const BOT_COUNT = Math.max(1, Number(process.env.BOT_COUNT ?? 5));
const CONTRACT_MIN_BET = parseEther("0.01"); // MafiaMarket.MIN_BET

// Minimal ABI surface the bots touch — kept in sync with contracts/contracts/MafiaMarket.sol.
const MARKET_ABI = [
  "function nextMatchId() view returns (uint256)",
  "function betToken() view returns (address)",
  "function matches(uint256) view returns (uint8 state, uint64 bettingOpenBlock, uint64 bettingCloseBlock, uint64 matchStartBlock, uint64 settlementDeadlineBlock, bytes32 roleCommit, bytes32 entropySeed, bytes32 personaPoolRoot, address teeSigner, string providerType, string providerIdentity, string tlsFingerprint, string nonce, uint8 playerCount, uint128 poolYes, uint128 poolNo, uint8 outcome, uint128 netPot, uint128 winningPool, bytes32 transcriptCID, uint16 feeBps, uint16 feeBpsDraw)",
  "function betYes(uint256 matchId, uint128 amount)",
  "function betNo(uint256 matchId, uint128 amount)",
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

// ---------- helpers ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

/** A random wager between MIN_BET and MAX_BET, in CHIP base units (clamped to the contract minimum). */
function randomBet(): bigint {
  const span = MAX_BET - MIN_BET;
  const r = span > 0n ? BigInt(Math.floor(Math.random() * 1e6)) * span / 1_000_000n : 0n;
  const amt = MIN_BET + r;
  return amt < CONTRACT_MIN_BET ? CONTRACT_MIN_BET : amt;
}

/** Resolve the bot signing wallets from env, or generate+persist a fresh fleet. */
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
  // are never discarded (they may already be funded) — we only ever append. Lowering BOT_COUNT below
  // the saved count keeps every saved wallet; raising it appends fresh ones.
  const existing: string[] = existsSync(WALLET_FILE) ? JSON.parse(readFileSync(WALLET_FILE, "utf8")).keys : [];
  const keys = [...existing];
  const added = Math.max(0, BOT_COUNT - keys.length);
  for (let i = 0; i < added; i++) keys.push(Wallet.createRandom().privateKey);
  if (added > 0 || !existsSync(WALLET_FILE)) {
    writeFileSync(WALLET_FILE, JSON.stringify({ keys }, null, 2));
  }
  if (existing.length && added > 0) {
    console.log(`Reusing ${existing.length} saved bot wallet(s) and adding ${added} new → ${WALLET_FILE}.`);
    console.log("⚠️  Fund the NEW wallet(s) with testnet 0G for gas (https://faucet.0g.ai).");
  } else if (existing.length) {
    console.log(`Reusing ${keys.length} saved bot wallet(s) from ${WALLET_FILE}.`);
  } else {
    console.log(`Generated ${keys.length} bot wallet(s) → ${WALLET_FILE} (gitignored).`);
    console.log("⚠️  Fund these with testnet 0G for gas (https://faucet.0g.ai):");
  }
  return keys.map((pk) => new Wallet(pk, provider));
}

// ---------- main ----------
async function main() {
  if (!MARKET_ADDRESS) {
    console.error("MAFIA_MARKET_ADDRESS is not set (check .env). Aborting.");
    process.exit(1);
  }

  const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
  const wallets = loadWallets(provider);
  const market = new Contract(MARKET_ADDRESS, MARKET_ABI, provider);
  const tokenAddr = (process.env.BET_TOKEN_ADDRESS ?? (await market.betToken())) as string;

  console.log("─".repeat(60));
  console.log("Liquidity bots — MOCK demo liquidity (real on-chain CHIP wagers)");
  console.log(`  RPC      : ${RPC_URL} (chain ${CHAIN_ID})`);
  console.log(`  Market   : ${MARKET_ADDRESS}`);
  console.log(`  CHIP     : ${tokenAddr}`);
  console.log(`  Bet range: ${formatEther(MIN_BET)}–${formatEther(MAX_BET)} CHIP, YES prob ${YES_PROB}`);
  console.log(`  Props    : ${BET_PROPS ? "on" : "off"}  Poll: ${POLL_MS}ms`);
  for (const w of wallets) {
    const native = await provider.getBalance(w.address);
    const flag = native === 0n ? "  ⚠️  NO GAS — fund this address" : "";
    console.log(`  bot ${w.address}  ${formatEther(native)} 0G${flag}`);
  }
  console.log("─".repeat(60));

  // Per (matchId, market-key) → set of bot indexes that have already wagered, so we never double-bet.
  const handled = new Map<string, Set<number>>();
  const mark = (key: string, bot: number) => {
    let s = handled.get(key);
    if (!s) handled.set(key, (s = new Set()));
    s.add(bot);
  };
  const has = (key: string, bot: number) => handled.get(key)?.has(bot) ?? false;

  /** Ensure a bot can stake: skip on no gas, top up CHIP from the faucet, max-approve the market once. */
  async function prepare(bot: Wallet, amount: bigint): Promise<boolean> {
    const native = await provider.getBalance(bot.address);
    if (native === 0n) return false; // no gas — silently skip (warned at startup)
    const token = new Contract(tokenAddr, TOKEN_ABI, bot);
    const bal = (await token.balanceOf(bot.address)) as bigint;
    if (bal < amount) {
      const tx = await token.faucet();
      await tx.wait();
    }
    const allowance = (await token.allowance(bot.address, MARKET_ADDRESS)) as bigint;
    if (allowance < amount) {
      const tx = await token.approve(MARKET_ADDRESS, MaxUint256);
      await tx.wait();
    }
    return true;
  }

  /** Place the main YES/NO wagers for one open match across the fleet. */
  async function betMatch(matchId: number, deadline: bigint) {
    const block = BigInt(await provider.getBlockNumber());
    const key = `m${matchId}`;
    for (let i = 0; i < wallets.length; i++) {
      if (has(key, i)) continue;
      if (block > deadline) continue; // past settlement deadline — betting refused on-chain
      const bot = wallets[i]!;
      for (let n = 0; n < MAX_BETS_PER_MATCH; n++) {
        const amount = randomBet();
        try {
          if (!(await prepare(bot, amount))) break;
          const side = Math.random() < YES_PROB ? "YES" : "NO";
          const c = market.connect(bot) as Contract;
          const tx = side === "YES" ? await c.betYes(matchId, amount) : await c.betNo(matchId, amount);
          await tx.wait();
          console.log(`✓ match ${matchId}: bot ${i} bet ${formatEther(amount)} CHIP ${side}`);
        } catch (e) {
          console.warn(`✗ match ${matchId}: bot ${i} bet failed — ${(e as Error).message.split("\n")[0]}`);
          break; // don't hammer a failing bot this round; retry next poll
        }
        await sleep(randInt(300, 1200));
      }
      mark(key, i);
    }
  }

  /** Optionally seed a couple of categorical side markets so they aren't empty either. */
  async function betProps(matchId: number, deadline: bigint) {
    if (!BET_PROPS) return;
    let count = 0;
    try {
      count = Number((await market.propCount(matchId)) as bigint);
    } catch {
      return;
    }
    const block = BigInt(await provider.getBlockNumber());
    if (block > deadline) return;
    // Seed up to 2 random props per match so the prop book shows activity without flooding it.
    const propIdxs = Array.from({ length: count }, (_, i) => i).sort(() => Math.random() - 0.5).slice(0, 2);
    for (const propIdx of propIdxs) {
      const key = `m${matchId}p${propIdx}`;
      for (let i = 0; i < wallets.length; i++) {
        if (has(key, i)) continue;
        const bot = wallets[i]!;
        const amount = randomBet();
        try {
          const pr = (await market.getProp(matchId, propIdx)) as { closed: boolean; numOutcomes: bigint };
          if (pr.closed) {
            mark(key, i);
            continue;
          }
          if (!(await prepare(bot, amount))) break;
          // Categorical market: stake on a random valid outcome (PlayerFate: a death-round bucket;
          // RoundVotedOut: a seat or "no one").
          const numOutcomes = Number(pr.numOutcomes);
          const outcome = randInt(0, Math.max(0, numOutcomes - 1));
          const c = market.connect(bot) as Contract;
          const tx = await c.betProp(matchId, propIdx, outcome, amount);
          await tx.wait();
          console.log(`✓ match ${matchId} prop ${propIdx}: bot ${i} bet ${formatEther(amount)} CHIP on outcome ${outcome}`);
        } catch (e) {
          console.warn(`✗ match ${matchId} prop ${propIdx}: bot ${i} prop bet failed — ${(e as Error).message.split("\n")[0]}`);
          break;
        }
        mark(key, i);
        await sleep(randInt(300, 1200));
      }
    }
  }

  console.log("Watching for open matches…  (Ctrl-C to stop)\n");
  let lastSeenNext = 0;
  for (;;) {
    try {
      const next = Number((await market.nextMatchId()) as bigint);
      const from = Math.max(0, next - BACKFILL_WINDOW);
      for (let matchId = from; matchId < next; matchId++) {
        const m = await market.matches(matchId);
        const state = Number(m.state);
        if (state !== 1) continue; // 1 == Created (OPEN); skip Locked/Settled/Refund/None
        const block = BigInt(await provider.getBlockNumber());
        if (block < BigInt(m.bettingOpenBlock)) continue; // betting hasn't opened yet
        const deadline = BigInt(m.settlementDeadlineBlock);
        await betMatch(matchId, deadline);
        await betProps(matchId, deadline);
      }
      if (next !== lastSeenNext) lastSeenNext = next;
    } catch (e) {
      console.warn(`poll error — ${(e as Error).message.split("\n")[0]}`);
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
