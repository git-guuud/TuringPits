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
import { withRetry, isTransientError } from "@turingpits/players/dist/retry.js";
import { MAFIA_MARKET_ABI, ROLE_ENUM, marketStateOf, outcomeOf, propStateOf, winningSideOf } from "./abi.js";
import { toPublicState, toPublicTurn } from "./redact.js";
import { gateTurn, newNightGate } from "./night.js";
import { buildPersonas, buildProvider, runMatch } from "./match-runner.js";
import type { Hub } from "./broadcast.js";
import type { PropSnapshot } from "./wire.js";

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
  // Called as soon as a match is created on-chain (before it could fail mid-run), so the caller can
  // track it and guarantee a refund path if the round is later abandoned. See sweepAbandonedMatches.
  onMatchCreated?: (matchId: number, settlementDeadlineBlock: number) => void;
  // Settlement deadline budget (wall-clock seconds after match start). Must comfortably exceed
  // how long the match takes to play out — live 0G inference is rate-limited (~10/min), so a
  // full match runs many minutes. Default is generous; settle() reverts "deadline passed" past it.
  settlementDeadlineSeconds: number;
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

  // Resilience: testnet RPC/inference can drop a connection during the (long) live match. Retry
  // transient failures so one timed-out call doesn't abort the whole run; reverts still fail fast.
  const rpc = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
    withRetry(fn, {
      isRetryable: isTransientError,
      onRetry: (e, attempt, d) =>
        console.warn(`[orch] transient ${label} failure (retry ${attempt} in ${d}ms): ${(e as Error).message ?? e}`),
    });
  const head = () => rpc("getBlockNumber", () => provider.getBlockNumber());

  const n = cfg.playerCount;
  const seed = cfg.seed ?? randomSeed();
  const nonce = `live-${Date.now()}`;
  // Cast personas from the match seed so the table draws a different, reproducible-per-seed set of
  // voices each round (roles are seeded the same way), instead of always the first N in fixed order.
  const personas = buildPersonas(n, seed);

  // 1. Roles + commit (engine). Roles stay secret until settle's reveal.
  const roleNames = assignRoles(seed, n) as string[];
  const salt = generateSalt();
  const roleCommit = commitRoles(roleNames as never, salt);

  // 2. Provider (real TEE or labeled-local signer) and its registered signer.
  const { provider: inference, isMock, teeSigner, providerMeta } = await rpc("provider setup", () => buildProvider());

  // 3. Measure the actual block rate, then size the schedule from it. 0G mines very fast, so a
  //    fixed "+N blocks" guess either reverts "open in past" (too small to outrun tx inclusion)
  //    or creates a long "betting not started" dead zone (too large). Contract constants:
  //    MIN_BETTING_WINDOW=100, LOCK_BUFFER=5, MIN_MATCH_DURATION=25.
  const MIN_BETTING_WINDOW = 100, LOCK_BUFFER = 5, MIN_MATCH_DURATION = 25;
  const SAMPLE_MS = 4000;
  const sB0 = await head();
  await sleep(SAMPLE_MS);
  const sB1 = await head();
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
    settlementDeadlineBlock =
      matchStartBlock + Math.max(MIN_MATCH_DURATION + 1, Math.ceil(bps * cfg.settlementDeadlineSeconds));
  };
  computeSchedule(openMargin, await head());

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
    providerType: providerMeta.providerType,
    providerIdentity: providerMeta.providerIdentity,
    tlsFingerprint: providerMeta.tlsFingerprint,
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
      createRcpt = await rpc("createMatch", async () => {
        const createTx = await market.getFunction("createMatch")(buildParams());
        return createTx.wait();
      });
      break;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (!msg.includes("open in past") || attempt === 4) throw e;
      margin *= 2;
      computeSchedule(margin, await head());
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
  if (matchId < 0) matchId = Number(await rpc("nextMatchId", () => market.getFunction("nextMatchId")())) - 1;
  console.log(`[orch] matchId=${matchId} betting blocks ${bettingOpenBlock}..${bettingCloseBlock}`);
  // Register the match NOW (before any later step can throw) so the caller can guarantee a refund
  // path even if this round is abandoned after bets are placed.
  cfg.onMatchCreated?.(matchId, settlementDeadlineBlock);

  // 4. match_init + open market.
  hub.broadcast({
    type: "match_init",
    nonce,
    personas,
    record: {
      roleCommit,
      teeSigner,
      providerType: providerMeta.providerType,
      providerIdentity: providerMeta.providerIdentity,
      tlsFingerprint: providerMeta.tlsFingerprint,
      playerCount: n,
      personaPoolRoot,
    },
    isMock,
    marketAddress: cfg.marketAddress,
    matchId,
    chainId: cfg.chainId,
  });

  // Read the categorical side markets so the UI can show their live per-outcome pools + settled winner
  // alongside the faction-win market. createMatch makes n+1 props — PlayerFate (propIdx 0..n-1) + the
  // round-1 RoundVotedOut market (propIdx n) — and openVotedOutRound appends a fresh RoundVotedOut
  // market per later round, so the count GROWS during the match: read propCount each pass. The on-chain
  // `kind` byte is the label authority (0 PlayerFate / 1 RoundVotedOut); `param` is the seat or round.
  const PROP_KIND = { 0: "PLAYER_FATE", 1: "ROUND_VOTED_OUT" } as const;
  const readProps = async (): Promise<PropSnapshot[]> => {
    const count = Number(await rpc("propCount", () => market.getFunction("propCount")(matchId)));
    return Promise.all(
      Array.from({ length: count }, (_, i) =>
        rpc(`getProp:${i}`, () => market.getFunction("getProp")(matchId, i)).then((pr) => {
          const state = propStateOf(Number(pr.state));
          return {
            index: i,
            kind: PROP_KIND[Number(pr.kind) as 0 | 1] ?? "PLAYER_FATE",
            param: Number(pr.param),
            numOutcomes: Number(pr.numOutcomes),
            pools: (pr.pools as bigint[]).map((p) => formatEther(p)),
            closed: Boolean(pr.closed),
            state,
            winningOutcome: state === "RESOLVED" ? Number(pr.winningOutcome) : undefined,
          };
        }),
      ),
    );
  };

  const readPools = async () => {
    const [m, props] = await Promise.all([
      rpc("readPools", () => market.getFunction("matches")(matchId)),
      readProps(),
    ]);
    return {
      state: marketStateOf(Number(m.state)),
      yesPool: formatEther(m.poolYes as bigint),
      noPool: formatEther(m.poolNo as bigint),
      outcome: Number(m.outcome),
      props,
    };
  };

  const p0 = await readPools();
  hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: false, yesPool: p0.yesPool, noPool: p0.noPool, props: p0.props } });

  // 5a. Pre-open: the chain has NOT yet reached bettingOpenBlock, so bets would revert
  //     "betting not started". Hold the UI in a non-clickable pre-open state until it does.
  console.log(`[orch] sealing — waiting for chain to reach open block ${bettingOpenBlock}`);
  while ((await head()) < bettingOpenBlock) {
    const p = await readPools();
    hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: false, yesPool: p.yesPool, noPool: p.noPool, props: p.props } });
    await sleep(3000);
  }

  // 5b. Betting is now LIVE and STAYS OPEN until settle() — there is no block-based close and no
  //     lock step. The market accepts wagers right through the match; only settlement closes it.
  //     We emit no `closesAt`, so the UI shows an open market with no countdown.
  console.log(`[orch] betting LIVE — open until settled`);
  {
    const p = await readPools();
    hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: true, yesPool: p.yesPool, noPool: p.noPool, props: p.props } });
  }

  // Keep pushing live pool sizes (still OPEN) on a background tick while the match plays, so bets
  // placed during the match show up immediately. Cleared right before settlement.
  const poolTick = setInterval(() => {
    void (async () => {
      try {
        const p = await readPools();
        hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: true, yesPool: p.yesPool, noPool: p.noPool, props: p.props } });
      } catch {
        /* transient RPC read; next tick retries */
      }
    })();
  }, 4000);

  // 6. (no lock step — betting stays open until settle).

  // 7. Run the match, streaming redacted turns paced by onTurn's await.
  //    NIGHT IS NEVER STREAMED PER-ACTOR: a night turn names the seat + its action (kill/save/
  //    investigate) + speech, which would reveal who is Mafia/Doctor/Detective mid-game. Instead
  //    we emit one `night` beat at nightfall and one `dawn` beat at first light carrying only the
  //    public death. Day votes stream normally. Settlement uses result.turns, so this redaction of
  //    the *broadcast* does not affect on-chain verification.
  const gate = newNightGate(personas.map((p) => p.seat));

  // Contract-level "no betting a decided market": the moment an outcome becomes public, freeze that
  // prop on-chain so nobody can pile onto an already-won side for a riskless profit. closeProp is
  // payout-neutral (settlement still comes from the verified run), so this only refuses NEW stakes —
  // it never touches outcomes. One shared `frozen` set (keyed by propIdx) covers all three kinds;
  // `freeze` is idempotent and returns whether it actually closed (so callers can debounce pool pushes).
  const frozen = new Set<number>();
  const freeze = async (propIdx: number, label: string): Promise<boolean> => {
    if (frozen.has(propIdx)) return false;
    frozen.add(propIdx);
    try {
      await rpc(`closeProp:${label}:${propIdx}`, async () => {
        const tx = await market.getFunction("closeProp")(matchId, propIdx);
        return tx.wait();
      });
      return true;
    } catch (e) {
      // Non-fatal: the prop still resolves at settle(); a missed close only leaves the frontend gate.
      console.warn(`[orch] closeProp ${label} idx=${propIdx} failed:`, (e as Error).message);
      return false;
    }
  };
  const pushPools = async (): Promise<void> => {
    const p = await readPools();
    hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: true, yesPool: p.yesPool, noPool: p.noPool, props: p.props } });
  };

  // PlayerFate: freeze a fallen seat's market the moment its death is public (propIdx == seat). Once a
  // seat dies, its fate (which death-round bucket) is fully decided, so no more bets on it.
  const closeFallenProps = async (state: { players: ReadonlyArray<{ id: number; alive: boolean }> }): Promise<void> => {
    let changed = false;
    for (const pl of state.players) {
      if (pl.alive) continue;
      if (await freeze(pl.id, "player-fate")) {
        console.log(`[orch] player-fate prop seat=${pl.id} closed on-chain (fell) matchId=${matchId}`);
        changed = true;
      }
    }
    if (changed) await pushPools();
  };

  // The RECURRING "voted out" market: ONE market per day-vote round. createMatch floats round 1; as the
  // match advances we open the NEXT round's market (so it's bettable while that round plays) and freeze
  // a round's market once ITS day vote has resolved. The market for round R lives at propIdx voIdx(R).
  const voIdx = (round: number) => n + (round - 1);
  let votedOutOpened = 1; // round-1 market created in createMatch
  const syncVotedOutMarkets = async (state: { round: number; winner: unknown }): Promise<void> => {
    const over = state.winner != null;
    const cur = state.round; // 1-based current round
    let changed = false;
    // 1. Open each round's market as the match reaches it — but never ahead of play, and never once the
    //    match is over (a round with no day vote needs no market). Sequential; retries on a later turn.
    if (!over) {
      while (votedOutOpened < cur) {
        const next = votedOutOpened + 1;
        try {
          await rpc(`openVotedOutRound:${next}`, async () => {
            const tx = await market.getFunction("openVotedOutRound")(matchId);
            return tx.wait();
          });
          votedOutOpened = next;
          changed = true;
          console.log(`[orch] 'voted out' round ${next} market opened on-chain matchId=${matchId}`);
        } catch (e) {
          console.warn(`[orch] openVotedOutRound ${next} failed:`, (e as Error).message);
          break;
        }
      }
    }
    // 2. Freeze each round's market once its day vote has resolved (round < current) or the match ended.
    //    A single market per round, so the whole market closes at once (a night kill mid-round doesn't
    //    decide the day vote, so the still-live round stays open for the survivors).
    for (let r = 1; r <= votedOutOpened; r++) {
      if (over || r < cur) {
        if (await freeze(voIdx(r), `voted-out:r${r}`)) changed = true;
      }
    }
    if (changed) await pushPools();
  };

  let result;
  try {
    result = await runMatch({
      seed,
      n,
      nonce,
      personas,
      provider: inference,
      onTurn: async (turn, state) => {
        const msgs = gateTurn(
          gate,
          turn.structuredDecision.phase,
          turn.structuredDecision.round,
          toPublicState(state),
          toPublicTurn(turn),
        );
        for (const m of msgs) {
          hub.broadcast(m);
          await sleep(cfg.moveIntervalMs);
        }
        // After the public death beat lands, freeze the fallen seat's player-fate market on-chain.
        await closeFallenProps(state);
        // The recurring "voted out" market opens the new round's market and freezes already-resolved
        // ones as the match advances round by round.
        await syncVotedOutMarkets(state);
      },
      // Daytime deliberation streams as-is: it is public day speech (the discussion pass never runs
      // at night), so no role can leak. Paced like a turn so the stage can read it.
      onDiscussion: async (entry, state) => {
        hub.broadcast({ type: "discussion", seat: entry.seat, round: entry.round, speech: entry.speech, state: toPublicState(state) });
        await sleep(cfg.moveIntervalMs);
      },
    });
  } finally {
    // Stop the live pool ticker — betting closes via settle() next (or the match was abandoned).
    clearInterval(poolTick);
  }

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
  const settleRcpt = await rpc("settle", async () => {
    const settleTx = await market.getFunction("settle")(matchId, moves, revealedRoles, salt, transcriptCID);
    return settleTx.wait();
  });

  // 10. Push final market + settled. Every resolution is announced — including DRAW (mistrial,
  //     stakes returned less a small fee) and VOID (a faction won but nobody backed it → full
  //     refund) — so the UI can guide bettors to reclaim their stake via claim().
  const pf = await readPools();
  const side = winningSideOf(pf.outcome);
  const outcome = outcomeOf(pf.outcome);
  hub.broadcast({ type: "market", market: { state: "SETTLED", yesPool: pf.yesPool, noPool: pf.noPool, winningSide: side, outcome, props: pf.props } });
  if (outcome) {
    hub.broadcast({
      type: "settled",
      outcome,
      winningSide: side,
      feeBpsDraw: cfg.feeBpsDraw,
      txHash: settleRcpt?.hash,
      transcriptCID: transcriptCID === ZeroHash ? undefined : transcriptCID,
    });
  }
  console.log(`[orch] settled matchId=${matchId} outcome=${pf.outcome} side=${side} tx=${settleRcpt?.hash}`);
}

/**
 * Liveness backstop for the continuous-rounds loop. When a round is abandoned (e.g. inference/RPC
 * failure between betting and settle), its match is left in Created/Locked with bettors' stakes
 * locked until someone calls enterRefundMode after the deadline. This sweeps the matches the server
 * created and, for any that are past their settlement deadline AND still hold bets, flips them to
 * RefundMode so bettors can refund() their full stake immediately — instead of depending on a
 * third party. Idempotent and safe to call every round: settled/already-refunded matches are just
 * dropped from `pending`, and matches still inside their settlement window are left untouched.
 *
 * MUST be called from the same single-threaded loop as runOneMatch (never concurrently): both send
 * txs from the host wallet, so serializing them avoids nonce races.
 */
export async function sweepAbandonedMatches(
  cfg: OrchestratorConfig,
  pending: Map<number, number>, // matchId -> settlementDeadlineBlock
): Promise<void> {
  if (pending.size === 0) return;
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const host = new Wallet(cfg.hostPrivateKey, provider);
  const market = new Contract(cfg.marketAddress, MAFIA_MARKET_ABI, host);

  let head: number;
  try {
    head = await provider.getBlockNumber();
  } catch (e) {
    console.warn(`[orch] sweep skipped — could not read head:`, (e as Error).message);
    return;
  }

  for (const [matchId, deadline] of [...pending]) {
    try {
      const m = await market.getFunction("matches")(matchId);
      const state = Number(m.state); // 0 None, 1 Created, 2 Locked, 3 Settled, 4 RefundMode
      // Finalized one way or another → stop tracking; bettors claim()/refund() at will.
      if (state === 3 || state === 4) {
        pending.delete(matchId);
        continue;
      }
      // Still inside its settlement window → the host may yet settle; leave it for a later sweep.
      if (head <= deadline) continue;

      // Past deadline and never settled. If it holds no bets there is nothing to protect — drop it
      // without spending gas. Otherwise flip it so stakes become refundable right now.
      const hasBets = (m.poolYes as bigint) > 0n || (m.poolNo as bigint) > 0n;
      if (!hasBets) {
        pending.delete(matchId);
        continue;
      }
      const tx = await market.getFunction("enterRefundMode")(matchId);
      await tx.wait();
      pending.delete(matchId);
      console.log(`[orch] abandoned matchId=${matchId} past deadline → RefundMode; bettors can refund()`);
    } catch (e) {
      // Leave it in `pending` so a later sweep retries; refund stays available on-chain regardless.
      console.warn(`[orch] sweep matchId=${matchId} failed:`, (e as Error).message);
    }
  }
}
