/**
 * Turing Pits server — Day-6 sequencer + WebSocket live stream (implements the documented stub).
 *
 * Starts a WebSocket hub, then runs one match end-to-end against the deployed MafiaMarket:
 * commit roles → createMatch → betting window → lockBetting → stream the real engine/players
 * match (role-redacted) at MOVE_INTERVAL_MS → reveal → settle. Spectators bet/claim directly
 * against the contract from their own wallets; this server is the owner/host.
 *
 * Required env: MAFIA_MARKET_ADDRESS, HOST_PRIVATE_KEY.
 * Optional: PORT, ZEROG_RPC_URL, CHAIN_ID, PLAYER_COUNT, MATCH_SEED, BETTING_WINDOW_BLOCKS,
 *           MOVE_INTERVAL_MS, FEE_BPS, FEE_BPS_DRAW, COMPUTE_PRIVATE_KEY, COMPUTE_PROVIDER_ADDRESS.
 */
import "dotenv/config";
import { Hub } from "./broadcast.js";
import { runOneMatch, type OrchestratorConfig } from "./orchestrator.js";

const PORT = Number(process.env.PORT ?? 8080);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[server] missing required env ${name}. See server/README or the runbook.`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const cfg: OrchestratorConfig = {
    rpcUrl: process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai",
    chainId: Number(process.env.CHAIN_ID ?? 16602),
    marketAddress: requireEnv("MAFIA_MARKET_ADDRESS"),
    hostPrivateKey: requireEnv("HOST_PRIVATE_KEY"),
    playerCount: Number(process.env.PLAYER_COUNT ?? 5),
    seed: process.env.MATCH_SEED,
    bettingWindowBlocks: Number(process.env.BETTING_WINDOW_BLOCKS ?? 101),
    moveIntervalMs: Number(process.env.MOVE_INTERVAL_MS ?? 1000),
    feeBps: Number(process.env.FEE_BPS ?? 200),
    feeBpsDraw: Number(process.env.FEE_BPS_DRAW ?? 50),
    enableStorage: (process.env.ENABLE_STORAGE ?? "false").toLowerCase() === "true",
    storageIndexerUrl: process.env.ZEROG_STORAGE_INDEXER_URL ?? "https://indexer-storage-testnet-turbo.0g.ai",
    storageRpcUrl: process.env.ZEROG_STORAGE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai",
    storagePrivateKey: process.env.STORAGE_PRIVATE_KEY ?? process.env.HOST_PRIVATE_KEY ?? "",
  };

  const hub = new Hub(PORT);
  console.log(`[server] WebSocket listening on :${PORT}`);
  console.log(`[server] market=${cfg.marketAddress} chain=${cfg.chainId} seats=${cfg.playerCount}`);

  try {
    await runOneMatch(hub, cfg);
    console.log("[server] match complete. Stream remains available for late joiners.");
  } catch (err) {
    console.error("[server] match failed:", err);
  }
}

void main();
