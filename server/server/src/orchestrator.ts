/**
 * Match orchestrator — drives ONE match end-to-end against the deployed MafiaMarket (v3),
 * mirroring contracts/test/PlayersIntegration.test.ts:
 *
 *   assignRoles+commit → createMatch (block schedule) → betting window (push pools)
 *   → lockBetting → playMatch (stream redacted turns via onTurn) → reveal
 *   → settle(moves, roles, salt) → push settled.
 *
 * Betting is BLOCK-gated by the contract (>= MIN_BETTING_WINDOW = 100 blocks), so the window
 * is measured in blocks, not a timer. Nothing here touches engine/players/contract logic.
 */
import { Contract, JsonRpcProvider, Wallet, ZeroHash, formatEther } from "ethers";
import { assignRoles, commitRoles, generateSalt } from "@turingpits/engine";
import { toSettlementMove } from "@turingpits/players/dist/match.js";
import { MAFIA_MARKET_ABI, ROLE_ENUM, marketStateOf, winningSideOf } from "./abi.js";
import { toPublicState, toPublicTurn } from "./redact.js";
import { buildPersonas, buildProvider, PROVIDER_META, runMatch } from "./match-runner.js";
import type { Hub } from "./broadcast.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface OrchestratorConfig {
  rpcUrl: string;
  chainId: number;
  marketAddress: string;
  hostPrivateKey: string;
  playerCount: number;
  seed?: string;
  bettingWindowBlocks: number; // must be > 100
  bettingWindowSeconds: number; // wall-clock floor so humans can actually bet
  openLeadSeconds: number;      // lead time before betting opens (covers createMatch tx inclusion)
  moveIntervalMs: number;
  feeBps: number;
  feeBpsDraw: number;
  // 0G Storage evidence layer (optional; off unless enableStorage = true).
  enableStorage: boolean;
  storageIndexerUrl: string;
  storageRpcUrl: string;
  storagePrivateKey: string;
}

/**
 * Upload evidence bytes to 0G Storage and return the content root as bytes32. Lazy-imports the
 * storage package (and its SDK) ONLY when enabled, so the default path never loads it. Any
 * failure falls back to ZeroHash so the match still settles — storage is evidence, not a gate.
 */
async function uploadEvidence(cfg: OrchestratorConfig, kind: string, build: () => Promise<Uint8Array>): Promise<string> {
  if (!cfg.enableStorage) return ZeroHash;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = await import("@turingpits/storage/dist/zerog-storage.js");
    const client = store.createZeroGStorage({
      indexerUrl: cfg.storageIndexerUrl,
      rpcUrl: cfg.storageRpcUrl,
      privateKey: cfg.storagePrivateKey,
    });
    const ref = await client.upload(await build());
    console.log(`[orch] 0G Storage ${kind} root=${ref.root}`);
    return ref.root as string;
  } catch (e) {
    console.warn(`[orch] storage ${kind} upload failed → ZeroHash:`, (e as Error).message);
    return ZeroHash;
  }
}

function randomSeed(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function runOneMatch(hub: Hub, cfg: OrchestratorConfig): Promise<void> {
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const host = new Wallet(cfg.hostPrivateKey, provider);
  const market = new Contract(cfg.marketAddress, MAFIA_MARKET_ABI, host);

  const n = cfg.playerCount;
  const seed = cfg.seed ?? randomSeed();
  const nonce = `live-${Date.now()}`;
  const personas = buildPersonas(n);

  // 1. Roles + commit (engine). Roles stay secret until settle's reveal.
  const roleNames = assignRoles(seed, n) as string[];
  const salt = generateSalt();
  const roleCommit = commitRoles(roleNames as never, salt);

  // 2. Provider (real TEE or labeled-local signer) and its registered signer.
  const { provider: inference, isMock, teeSigner } = await buildProvider();

  // 3. Measure the actual block rate, then size the schedule from it. 0G mines very fast, so a
  //    fixed "+N blocks" guess either reverts "open in past" (too small to outrun tx inclusion)
  //    or creates a long "betting not started" dead zone (too large). Contract constants:
  //    MIN_BETTING_WINDOW=100, LOCK_BUFFER=5, MIN_MATCH_DURATION=25.
  const MIN_BETTING_WINDOW = 100, LOCK_BUFFER = 5, MIN_MATCH_DURATION = 25;
  const SAMPLE_MS = 4000;
  const sB0 = await provider.getBlockNumber();
  await sleep(SAMPLE_MS);
  const sB1 = await provider.getBlockNumber();
  const bps = Math.max(1, (sB1 - sB0) / (SAMPLE_MS / 1000)); // blocks per second (floor 1)
  console.log(`[orch] measured ~${bps.toFixed(1)} blocks/sec`);

  // open margin must exceed the blocks produced while createMatch is being mined (openLeadSeconds);
  // the betting window is sized so it lasts ~bettingWindowSeconds of wall-clock; deadline is huge.
  const openMargin = Math.max(30, Math.ceil(bps * cfg.openLeadSeconds));
  const windowBlocks = Math.max(MIN_BETTING_WINDOW + 1, Math.ceil(bps * cfg.bettingWindowSeconds));

  let bettingOpenBlock = 0, bettingCloseBlock = 0, matchStartBlock = 0, settlementDeadlineBlock = 0;
  const computeSchedule = (margin: number, head: number) => {
    bettingOpenBlock = head + margin;
    bettingCloseBlock = bettingOpenBlock + windowBlocks;
    matchStartBlock = bettingCloseBlock + LOCK_BUFFER + 1;
    settlementDeadlineBlock = matchStartBlock + Math.max(MIN_MATCH_DURATION + 1, Math.ceil(bps * 600));
  };
  computeSchedule(openMargin, await provider.getBlockNumber());

  hub.reset();
  // 0G Storage evidence (optional): persona pool uploaded before the match.
  const personaPoolRoot = await uploadEvidence(cfg, "personas", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ser: any = await import("@turingpits/storage/dist/serialize.js");
    return ser.serializePersonas(personas);
  });
  console.log(`[orch] createMatch nonce=${nonce} seed=${seed.slice(0, 10)}… seats=${n} mock=${isMock}`);
  const buildParams = () => ({
    roleCommit,
    personaPoolRoot,
    teeSigner,
    providerType: PROVIDER_META.providerType,
    providerIdentity: PROVIDER_META.providerIdentity,
    tlsFingerprint: PROVIDER_META.tlsFingerprint,
    nonce,
    playerCount: n,
    bettingOpenBlock,
    bettingCloseBlock,
    matchStartBlock,
    settlementDeadlineBlock,
    feeBps: cfg.feeBps,
    feeBpsDraw: cfg.feeBpsDraw,
  });
  // Retry "open in past": if the chain out-ran our open block during tx inclusion, recompute
  // against the live head with a doubled margin and try again.
  let createRcpt: any = null;
  let margin = openMargin;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const createTx = await market.getFunction("createMatch")(buildParams());
      createRcpt = await createTx.wait();
      break;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (!msg.includes("open in past") || attempt === 4) throw e;
      margin *= 2;
      computeSchedule(margin, await provider.getBlockNumber());
      console.warn(`[orch] "open in past" — retrying with openMargin=${margin}, open=${bettingOpenBlock}`);
    }
  }

  // matchId from the MatchCreated event (fallback: nextMatchId - 1).
  let matchId = -1;
  for (const log of createRcpt?.logs ?? []) {
    try {
      const parsed = market.interface.parseLog(log);
      if (parsed?.name === "MatchCreated") {
        matchId = Number(parsed.args.matchId);
        break;
      }
    } catch {
      /* not our event */
    }
  }
  if (matchId < 0) matchId = Number(await market.getFunction("nextMatchId")()) - 1;
  console.log(`[orch] matchId=${matchId} betting blocks ${bettingOpenBlock}..${bettingCloseBlock}`);

  // 4. match_init + open market.
  hub.broadcast({
    type: "match_init",
    nonce,
    personas,
    record: {
      roleCommit,
      teeSigner,
      providerType: PROVIDER_META.providerType,
      providerIdentity: PROVIDER_META.providerIdentity,
      tlsFingerprint: PROVIDER_META.tlsFingerprint,
      playerCount: n,
      personaPoolRoot,
    },
    isMock,
    marketAddress: cfg.marketAddress,
    matchId,
    chainId: cfg.chainId,
  });

  const readPools = async () => {
    const m = await market.getFunction("matches")(matchId);
    return {
      state: marketStateOf(Number(m.state)),
      yesPool: formatEther(m.poolYes as bigint),
      noPool: formatEther(m.poolNo as bigint),
      outcome: Number(m.outcome),
    };
  };

  const p0 = await readPools();
  hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: false, yesPool: p0.yesPool, noPool: p0.noPool } });

  // 5a. Pre-open: the chain has NOT yet reached bettingOpenBlock, so bets would revert
  //     "betting not started". Hold the UI in a non-clickable pre-open state until it does.
  console.log(`[orch] sealing — waiting for chain to reach open block ${bettingOpenBlock}`);
  while ((await provider.getBlockNumber()) < bettingOpenBlock) {
    const p = await readPools();
    hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: false, yesPool: p.yesPool, noPool: p.noPool } });
    await sleep(3000);
  }

  // 5b. Live betting: chain is in [open, close). This is exactly when _bet() is accepted, so the
  //     UI "BET NOW" now matches on-chain reality — no "betting not started", no dead zone.
  console.log(`[orch] betting LIVE until block ${bettingCloseBlock} (~${cfg.bettingWindowSeconds}s)`);
  while ((await provider.getBlockNumber()) < bettingCloseBlock) {
    const p = await readPools();
    hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: true, yesPool: p.yesPool, noPool: p.noPool } });
    await sleep(4000);
  }

  // 6. Lock (optional convenience; settle works from Created too).
  try {
    const lockTx = await market.getFunction("lockBetting")(matchId);
    await lockTx.wait();
  } catch (e) {
    console.warn("[orch] lockBetting skipped:", (e as Error).message);
  }
  const pl = await readPools();
  hub.broadcast({ type: "market", market: { state: "LOCKED", yesPool: pl.yesPool, noPool: pl.noPool } });

  // 7. Run the match, streaming redacted turns paced by onTurn's await.
  const result = await runMatch({
    seed,
    n,
    nonce,
    personas,
    provider: inference,
    onTurn: async (turn, state) => {
      hub.broadcast({ type: "turn", turn: toPublicTurn(turn), state: toPublicState(state) });
      await sleep(cfg.moveIntervalMs);
    },
  });

  // 8. Reveal the roles + winner.
  hub.broadcast({ type: "reveal", roles: roleNames as never, winner: result.winner ?? "TOWN" });

  // 9. Settle on-chain: verified moves + revealed roles + salt. Transcript → 0G Storage (optional).
  const moves = result.turns.map(toSettlementMove);
  const revealedRoles = roleNames.map((r) => ROLE_ENUM[r]!);
  const transcriptCID = await uploadEvidence(cfg, "transcript", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ser: any = await import("@turingpits/storage/dist/serialize.js");
    return ser.serializeMatch({ winner: result.winner, turns: result.turns });
  });
  console.log(`[orch] settle matchId=${matchId} moves=${moves.length}`);
  const settleTx = await market.getFunction("settle")(matchId, moves, revealedRoles, salt, transcriptCID);
  const settleRcpt = await settleTx.wait();

  // 10. Push final market + settled.
  const pf = await readPools();
  const side = winningSideOf(pf.outcome);
  hub.broadcast({ type: "market", market: { state: "SETTLED", yesPool: pf.yesPool, noPool: pf.noPool, winningSide: side } });
  if (side) hub.broadcast({ type: "settled", winningSide: side, txHash: settleRcpt?.hash, transcriptCID: transcriptCID === ZeroHash ? undefined : transcriptCID });
  console.log(`[orch] settled matchId=${matchId} outcome=${pf.outcome} side=${side} tx=${settleRcpt?.hash}`);
}
