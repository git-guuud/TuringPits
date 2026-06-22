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
 *           BETTING_WINDOW_BLOCKS, MOVE_INTERVAL_MS, FEE_BPS, FEE_BPS_DRAW, COMPUTE_PRIVATE_KEY,
 *           COMPUTE_PROVIDER_ADDRESS.
 *           (Note: pin MATCH_SEED only for repro — it makes every round play out identically.)
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
// Load the repo-root .env regardless of CWD (src/ and dist/ are both one level under server/).
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });
import { Hub } from "./broadcast.js";
import { runOneMatch, sweepAbandonedMatches, type OrchestratorConfig } from "./orchestrator.js";

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
    feeBpsDraw: Number(process.env.FEE_BPS_DRAW ?? 50),
    enableStorage: (process.env.ENABLE_STORAGE ?? "false").toLowerCase() === "true",
    storageIndexerUrl: process.env.ZEROG_STORAGE_INDEXER_URL ?? "https://indexer-storage-testnet-turbo.0g.ai",
    storageRpcUrl: process.env.ZEROG_STORAGE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai",
    storagePrivateKey: process.env.STORAGE_PRIVATE_KEY ?? process.env.HOST_PRIVATE_KEY ?? "",
    bettingWindowSeconds: Number(process.env.BETTING_WINDOW_SECONDS ?? 90),
    openLeadSeconds: Number(process.env.OPEN_LEAD_SECONDS ?? 12),
    // Generous by default so the slow, rate-limited live match settles in time (~30 min budget).
    settlementDeadlineSeconds: Number(process.env.SETTLEMENT_DEADLINE_SECONDS ?? 1800),
    onMatchCreated: (matchId, deadline) => pending.set(matchId, deadline),
  };

  const hub = new Hub(PORT);
  console.log(`[server] WebSocket listening on :${PORT}`);
  console.log(`[server] market=${cfg.marketAddress} chain=${cfg.chainId} seats=${cfg.playerCount}`);

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
      // Each round is independent: orchestrator resets the hub buffer and (unless MATCH_SEED is
      // pinned) draws a fresh random seed, so every round is a brand-new match.
      await runOneMatch(hub, cfg);
      console.log(`[server] round ${round}: match complete.`);
    } catch (err) {
      console.error(`[server] round ${round}: match failed:`, err);
    }

    console.log(`[server] intermission — next round in ~${INTERMISSION_SECONDS}s.`);
    await sleep(INTERMISSION_SECONDS * 1000);
  }
}

void main();
