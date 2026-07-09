/**
 * Turing Pits server — Day-6 sequencer + WebSocket live stream (implements the documented stub).
 *
 * Starts a WebSocket hub, then runs matches end-to-end against the deployed MafiaMarket in a
 * continuous loop — each round: commit roles → createMatch → betting window → lockBetting → stream
 * the real engine/players match (role-redacted) at MOVE_INTERVAL_MS → reveal → settle, then an
 * INTERMISSION_SECONDS pause before the next round. Spectators bet/claim directly against the
 * contract from their own wallets; this server is the owner/host.
 *
 * Required env: MAFIA_MARKET_ADDRESS, HOST_PRIVATE_KEY.
 * Optional: PORT, INTERMISSION_SECONDS, ZEROG_RPC_URL, CHAIN_ID, PLAYER_COUNT, MATCH_SEED,
 *           BETTING_WINDOW_BLOCKS, MOVE_INTERVAL_MS, FEE_BPS, COMPUTE_PRIVATE_KEY,
 *           COMPUTE_PROVIDER_ADDRESS.
 *           (Note: pin MATCH_SEED only for repro — it makes every round play out identically.)
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
// Load the repo-root .env regardless of CWD (src/ and dist/ are both one level under server/).
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });
import { Hub } from "./broadcast.js";
import { createRelayer } from "./relayer.js";
import { createPoolSignal } from "./pool-signal.js";
import { createNameRegistry } from "./names.js";
import { createTts, parseKeys } from "./tts.js";
import { DEFAULT_FALLBACK_VOICE, loadVoiceMap } from "./voices.js";
import { createProviderCache } from "./match-runner.js";
import { prepareRound, runOneMatch, sweepAbandonedMatches, type OrchestratorConfig } from "./orchestrator.js";

const PORT = Number(process.env.PORT ?? 8080);
const INTERMISSION_SECONDS = Number(process.env.INTERMISSION_SECONDS ?? 60);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[server] missing required env ${name}. See server/README or the runbook.`);
    process.exit(1);
  }
  return v;
}

async function main() {
  // Matches the server has created but not yet seen finalized (matchId -> settlementDeadlineBlock).
  // Drives abandoned, past-deadline matches to RefundMode so bettors never wait on a third party.
  const pending = new Map<number, number>();

  // Real-time betting book: the relayer bumps this the instant a sponsored bet lands, and the running
  // match registers its pool pusher on it — so the odds move as fast as the bet mines, not on a poll.
  const poolSignal = createPoolSignal();

  // ONE provider bundle for all rounds: the live build (broker setup + a PAID probe inference,
  // ~10-20s) runs once; each round's getProvider just re-checks the TEE signer and rebuilds only on
  // rotation. Invalidated after a failed match so a stale signer/meta can't wedge every later round.
  const providerCache = createProviderCache();

  const cfg: OrchestratorConfig = {
    rpcUrl: process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai",
    chainId: Number(process.env.CHAIN_ID ?? 16602),
    marketAddress: requireEnv("MAFIA_MARKET_ADDRESS"),
    hostPrivateKey: requireEnv("HOST_PRIVATE_KEY"),
    playerCount: Number(process.env.PLAYER_COUNT ?? 6),
    seed: process.env.MATCH_SEED,
    bettingWindowBlocks: Number(process.env.BETTING_WINDOW_BLOCKS ?? 101),
    moveIntervalMs: Number(process.env.MOVE_INTERVAL_MS ?? 1000),
    feeBps: Number(process.env.FEE_BPS ?? 200),
    enableStorage: (process.env.ENABLE_STORAGE ?? "false").toLowerCase() === "true",
    storageIndexerUrl: process.env.ZEROG_STORAGE_INDEXER_URL ?? "https://indexer-storage-testnet-turbo.0g.ai",
    storageRpcUrl: process.env.ZEROG_STORAGE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai",
    storagePrivateKey: process.env.STORAGE_PRIVATE_KEY ?? process.env.HOST_PRIVATE_KEY ?? "",
    bettingWindowSeconds: Number(process.env.BETTING_WINDOW_SECONDS ?? 90),
    // Covers only createMatch's own tx inclusion (~1-2 blocks): the orchestrator samples the chain
    // head immediately before the create tx, so nothing else eats into this lead anymore.
    openLeadSeconds: Number(process.env.OPEN_LEAD_SECONDS ?? 5),
    // Deliberate pause on the freshly-convened court before the first night — so a new round doesn't cut
    // straight to nightfall and there's real time to back the headline markets. 0 = instant start.
    preMatchBettingSeconds: Number(process.env.PRE_MATCH_BETTING_SECONDS ?? 20),
    // In-loop betting windows (the match pauses to spotlight one side market). Seconds; 0 disables one.
    // Set short for local iteration so you don't sit through the full pause every round.
    nightKillWindowSeconds: Number(process.env.NIGHT_KILL_WINDOW_SECONDS ?? 45),
    votedOutWindowSeconds: Number(process.env.VOTED_OUT_WINDOW_SECONDS ?? 45),
    detectiveClaimWindowSeconds: Number(process.env.DETECTIVE_CLAIM_WINDOW_SECONDS ?? 45),
    // Generous by default so the slow, rate-limited live match settles in time (~90 min budget). This
    // deadline block also gates bet acceptance on-chain (betProp reverts "betting closed" past it), so a
    // long match must not outrun it — bets on later rounds would start reverting mid-game if it did.
    settlementDeadlineSeconds: Number(process.env.SETTLEMENT_DEADLINE_SECONDS ?? 5400),
    // 0G's block time is a fixed ~0.5s (measured ~2.03 blk/s, <1% drift over a week). NOT sampled at
    // runtime — a short sample can't resolve a 0.5s block time against 1s timestamps and once read ~1.0,
    // halving the real deadline. 2.0 tracks the true rate (~1.5% under, negligible next to the ~90min
    // deadline budget) so block-derived windows (open lead, betting window, deadline) land close to intent.
    blocksPerSecond: Number(process.env.BLOCKS_PER_SECOND ?? 2.0),
    onMatchCreated: (matchId, deadline) => pending.set(matchId, deadline),
    poolSignal,
    getProvider: () => providerCache.get(),
  };

  // Optional EIP-2771 gas relayer — only active if RELAYER_PRIVATE_KEY + FORWARDER_ADDRESS are set.
  // Lets spectators bet/claim with zero native 0G (it signs, the relayer pays gas). See relayer.ts.
  const relayer = createRelayer({
    rpcUrl: cfg.rpcUrl,
    chainId: cfg.chainId,
    relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY ?? "",
    forwarderAddress: process.env.FORWARDER_ADDRESS ?? "",
    marketAddress: cfg.marketAddress,
    // Push the live book the instant a relayed bet mines (the common path — session keys + bots relay).
    onSponsoredWrite: (matchId) => poolSignal.bump(matchId),
  });

  // Optional spoken-dialogue layer — only active if ELEVENLABS_API_KEY is set. Voices the players'
  // lines (tone-tagged, one voice per persona) over POST /tts; the keys never leave the server. See
  // tts.ts. With no key, /tts/info reports enabled:false and the frontend stays silent.
  // ELEVENLABS_API_KEYS (plural) accepts a comma/whitespace-separated pool that rolls over to the next
  // key when one runs out of credit; ELEVENLABS_API_KEY (singular) still works as a one-key pool.
  const elevenLabsKeys = process.env.ELEVENLABS_API_KEYS ?? process.env.ELEVENLABS_API_KEY ?? "";
  const tts = createTts({
    apiKey: elevenLabsKeys,
    modelId: process.env.ELEVENLABS_MODEL_ID ?? "eleven_v3",
    voiceMap: loadVoiceMap(process.env.ELEVENLABS_VOICE_MAP),
    defaultVoiceId: process.env.ELEVENLABS_DEFAULT_VOICE_ID ?? DEFAULT_FALLBACK_VOICE,
    nimApiKey: process.env.NVIDIA_NIM_API_KEY ?? "",
    llmModel: process.env.TTS_LLM_MODEL ?? "meta/llama-3.1-8b-instruct",
  });

  // Address→handle registry for the leaderboard. Always on (a signed-set + public-read map); a
  // deterministic pseudonym covers every address client-side, this just shares custom handles.
  const names = createNameRegistry({});

  // One HTTP server shared by the WS hub (upgrade), the relay routes (/relay, /relay/info), the name
  // registry (/names), and a read-only /status route. `hub` is assigned just below; the handler only
  // dereferences it at request time, by which point it is set. Other paths get a 200 health response.
  let hub: Hub | undefined;
  const httpServer = createServer((req, res) => {
    void (async () => {
      // Lobby status: "is court in session, what round, how big the pot" — derived from the hub's
      // in-memory buffer (no chain read, no socket), so polling it can never start a match.
      if (hub && (req.url ?? "").split("?")[0] === "/status" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(hub.snapshot()));
        return;
      }
      if (relayer && (await relayer.handle(req, res))) return;
      if (await names.handle(req, res)) return;
      if (await tts.handle(req, res)) return;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("TuringPits sequencer OK");
    })();
  });
  httpServer.listen(PORT);

  hub = new Hub(httpServer);
  console.log(`[server] HTTP + WebSocket listening on :${PORT}`);
  console.log(`[server] gas relayer: ${relayer ? `ENABLED (${relayer.relayerAddress})` : "disabled"}`);
  console.log(
    `[server] dialogue TTS: ${tts.enabled ? `ENABLED (${tts.info().model}, ${tts.info().tagger} tags, ${parseKeys(elevenLabsKeys).length} key(s))` : "disabled (set ELEVENLABS_API_KEY)"}`,
  );
  console.log(`[server] market=${cfg.marketAddress} chain=${cfg.chainId} seats=${cfg.playerCount}`);

  // Round 1's evidence (seed + personas + the slow 0G Storage persona upload, ~20-60s when enabled)
  // is prepared at boot, before any client connects; every later round's is prepared during the
  // intermission below. Either way the upload never sits between a client connecting and wagers opening.
  let prepared = await prepareRound(cfg);

  // Run rounds back-to-back forever, with a short intermission between each.
  for (let round = 1; ; round++) {
    // Backstop: drive any abandoned, past-deadline match into RefundMode so its bettors can recover
    // their stake. Runs in this loop (not a timer) so it never sends a host tx concurrently with a
    // match → no nonce races. Best-effort; refund stays available on-chain regardless.
    try {
      await sweepAbandonedMatches(cfg, pending);
    } catch (err) {
      console.error(`[server] refund sweep failed:`, err);
    }

    // Don't burn the betting window before anyone is watching — wait for a spectator. Returns
    // immediately if someone is already connected (the common case for rounds after the first).
    console.log(`[server] round ${round}: waiting for a client to connect before starting…`);
    await hub.waitForFirstClient();
    console.log(`[server] round ${round}: client connected — starting match.`);

    try {
      // Each round is independent: orchestrator resets the hub buffer and runs the pre-built
      // `prepared` seed/personas (fresh-random per round unless MATCH_SEED is pinned), so every
      // round is a brand-new match. `tts` lets the orchestrator pace the stage to the actual
      // spoken duration (and pre-warm each clip's cache).
      await runOneMatch(hub, cfg, tts, prepared);
      console.log(`[server] round ${round}: match complete.`);
    } catch (err) {
      console.error(`[server] round ${round}: match failed:`, err);
      // A failed round can mean the cached provider went stale mid-match (e.g. settle() hit
      // "bad TEE signature" after a TEE restart) — drop it so the next round rebuilds cleanly.
      providerCache.invalidate();
    }

    console.log(`[server] intermission — next round in ~${INTERMISSION_SECONDS}s.`);
    // Prepare the NEXT round's evidence while the intermission clock runs. Overlapping the sleep
    // alone is nonce-safe: the match is over, and the next round's sweep (host-wallet txs) starts
    // only after this settles — so the storage upload (same wallet) never races another tx.
    [prepared] = await Promise.all([prepareRound(cfg), sleep(INTERMISSION_SECONDS * 1000)]);
  }
}

void main();
