/**
 * Liquidity bots — # MOCK demo liquidity for the AI-Mafia markets.
 *
 * A small fleet of scripted wallets that watch the deployed `MafiaMarket` for newly-opened matches
 * and sprinkle small CHIP wagers on both sides (and, optionally, the per-seat survival side markets)
 * so the betting UI isn't an empty book when a human first lands on it. Every bet is a REAL on-chain
 * `betYes/betNo` in the CHIP `MockBetToken` — the same pools/payouts/fees/settlement the frontend
 * uses. The only "fake" part is that the stakers are scripts, not people, betting test money.
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
 *   RELAYER_URL                        relayer base URL (default the deployed Railway relayer)
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
// Deployed relayer that sponsors gas for the bots' meta-transactions.
const RELAYER_URL = (process.env.RELAYER_URL ?? "https://turingpits-production.up.railway.app").replace(/\/$/, "");
const MIN_BET = parseEther(process.env.BOT_MIN_BET ?? "0.5");
const MAX_BET = parseEther(process.env.BOT_MAX_BET ?? "5");
const YES_PROB = Number(process.env.BOT_YES_PROB ?? 0.5);
const BET_PROPS = /^(1|true|yes)$/i.test(process.env.BOT_BET_PROPS ?? "");
const POLL_MS = Number(process.env.BOT_POLL_MS ?? 8000);
const BACKFILL_WINDOW = Number(process.env.BOT_BACKFILL_WINDOW ?? 10);
const MAX_BETS_PER_MATCH = Math.max(1, Number(process.env.BOT_MAX_BETS_PER_MATCH ?? 1));
const BOT_COUNT = Math.max(1, Number(process.env.BOT_COUNT ?? 5));
const CONTRACT_MIN_BET = parseEther("0.01"); // MafiaMarket.MIN_BET
// Gas forwarded to each relayed inner call — comfortably covers faucet/approve/bet, under the relayer cap.
const RELAY_GAS = 600_000n;

// Minimal ABI surface the bots read — kept in sync with contracts/contracts/MafiaMarket.sol.
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
  console.log("Liquidity bots — MOCK demo liquidity (real on-chain CHIP wagers, gasless via relayer)");
  console.log(`  RPC      : ${RPC_URL} (chain ${relay.chainId})`);
  console.log(`  Relayer  : ${RELAYER_URL}  (wallet ${relay.relayer}, ${relay.relayerBalance} 0G${relay.funded ? "" : " ⚠️ OUT OF GAS"})`);
  console.log(`  Forwarder: ${relay.forwarder}`);
  console.log(`  Market   : ${marketAddr}`);
  console.log(`  CHIP     : ${tokenAddr}`);
  console.log(`  Bet range: ${formatEther(MIN_BET)}–${formatEther(MAX_BET)} CHIP, YES prob ${YES_PROB}`);
  console.log(`  Props    : ${BET_PROPS ? "on" : "off"}  Poll: ${POLL_MS}ms`);
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
      const txHash = body.txHash ?? "";
      if (txHash) await provider.waitForTransaction(txHash);
      return txHash;
    }
  }

  // Per (matchId, market-key) → set of bot indexes that have already wagered, so we never double-bet.
  const handled = new Map<string, Set<number>>();
  const mark = (key: string, bot: number) => {
    let s = handled.get(key);
    if (!s) handled.set(key, (s = new Set()));
    s.add(bot);
  };
  const has = (key: string, bot: number) => handled.get(key)?.has(bot) ?? false;

  const token = new Contract(tokenAddr, TOKEN_ABI, provider); // read-only balance/allowance checks

  /** Ensure a bot can stake: relay a faucet() when CHIP is low, then a one-time max-approve. */
  async function prepare(bot: Wallet, amount: bigint): Promise<void> {
    const bal = (await token.balanceOf(bot.address)) as bigint;
    if (bal < amount) {
      await relayCall(bot, tokenAddr, tokenIface.encodeFunctionData("faucet", []));
    }
    const allowance = (await token.allowance(bot.address, marketAddr)) as bigint;
    if (allowance < amount) {
      await relayCall(bot, tokenAddr, tokenIface.encodeFunctionData("approve", [marketAddr, MaxUint256]));
    }
  }

  /** Place the main YES/NO wagers for one open match across the fleet. */
  async function betMatch(matchId: number, closeBlock: bigint) {
    const key = `m${matchId}`;
    for (let i = 0; i < wallets.length; i++) {
      if (has(key, i)) continue;
      const bot = wallets[i]!;
      for (let n = 0; n < MAX_BETS_PER_MATCH; n++) {
        const amount = randomBet();
        try {
          await prepare(bot, amount);
          // Betting closes the moment the host locks the match at bettingCloseBlock. prepare() may have
          // just relayed a (slow) faucet+approve, so re-check the window right before staking — a bet
          // that lands after the lock reverts "not open" and burns the relayer's gas for nothing.
          if (BigInt(await provider.getBlockNumber()) >= closeBlock) return;
          const side = Math.random() < YES_PROB ? "YES" : "NO";
          const data =
            side === "YES"
              ? marketIface.encodeFunctionData("betYes", [matchId, amount])
              : marketIface.encodeFunctionData("betNo", [matchId, amount]);
          await relayCall(bot, marketAddr, data);
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
  async function betProps(matchId: number, closeBlock: bigint) {
    if (!BET_PROPS) return;
    let count = 0;
    try {
      count = Number((await market.propCount(matchId)) as bigint);
    } catch {
      return;
    }
    if (BigInt(await provider.getBlockNumber()) >= closeBlock) return;
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
          await prepare(bot, amount);
          // Same race as betMatch: the host locks the match (and may closeProp individual markets) as
          // the game advances. Re-check the window right before staking so we don't relay a doomed
          // betProp that reverts "not open"/"prop closed" and wastes the relayer's gas.
          if (BigInt(await provider.getBlockNumber()) >= closeBlock) return;
          // Categorical market: stake on a random valid outcome (PlayerFate: a death-round bucket;
          // RoundVotedOut: a seat or "no one").
          const numOutcomes = Number(pr.numOutcomes);
          const outcome = randInt(0, Math.max(0, numOutcomes - 1));
          const data = marketIface.encodeFunctionData("betProp", [matchId, propIdx, outcome, amount]);
          await relayCall(bot, marketAddr, data);
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
        const closeBlock = BigInt(m.bettingCloseBlock);
        if (block < BigInt(m.bettingOpenBlock)) continue; // betting hasn't opened yet
        // Stop at bettingCloseBlock, NOT settlementDeadlineBlock: the host locks/settles the match at
        // close, and betYes/betNo/betProp all revert "not open" once state leaves Created. A bet placed
        // in the [close, lock] window races the lock and lands after it — a guaranteed on-chain revert
        // that still costs the relayer gas. Gating here mirrors the frontend's betting window.
        if (block >= closeBlock) continue;
        await betMatch(matchId, closeBlock);
        await betProps(matchId, closeBlock);
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
