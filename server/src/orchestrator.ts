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
import { MAFIA_MARKET_ABI, ROLE_ENUM, marketStateOf, propStateOf } from "./abi.js";
import { toPublicState, toPublicTurn } from "./redact.js";
import { gateTurn, newNightGate } from "./night.js";
import { nightKillResolved, votedOutResolved } from "./round-markets.js";
import { runBetWindow as runBetWindowFn, type BetWindowMarket } from "./bet-windows.js";
import { classifyDetectiveClaim } from "./detective-claim.js";
import { buildPersonas, buildProvider, runMatch } from "./match-runner.js";
import type { Hub } from "./broadcast.js";
import type { PoolSignal } from "./pool-signal.js";
import type { PropSnapshot, WsMessage } from "./wire.js";
import { estimateSpeechMs, type Tts, type ToneInput } from "./tts.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Reject a promise that runs past `ms` so a slow synth can never stall the match loop. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

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
  // Pre-match betting hold: after betting opens, PAUSE on the freshly-convened court for this long before
  // the first night — so a new round doesn't cut straight to nightfall and spectators get real time to
  // back the headline markets. Seconds; 0 starts the match immediately (the old instant-nightfall behavior).
  preMatchBettingSeconds: number;
  moveIntervalMs: number;
  feeBps: number;
  // In-loop betting windows: the match PAUSES for this long and spotlights one side market so a
  // dramatic beat becomes a betting beat. Seconds; 0 disables that window (streams straight through).
  nightKillWindowSeconds: number;      // at nightfall, before the kill is revealed (freezes before dawn)
  votedOutWindowSeconds: number;       // after the discussion pass, before votes (freezes before the vote)
  detectiveClaimWindowSeconds: number; // on a public Detective claim (freezes when the window closes)
  // Called as soon as a match is created on-chain (before it could fail mid-run), so the caller can
  // track it and guarantee a refund path if the round is later abandoned. See sweepAbandonedMatches.
  onMatchCreated?: (matchId: number, settlementDeadlineBlock: number) => void;
  // Real-time odds: the relayer signals through this the instant a sponsored bet lands, so the book is
  // re-read + broadcast immediately instead of on the 10s backstop poll below. See pool-signal.ts. When
  // unset, the market still updates — just on the poll cadence.
  poolSignal?: PoolSignal;
  // Settlement deadline budget (wall-clock seconds after match start). Must comfortably exceed
  // how long the match takes to play out — live 0G inference is rate-limited (~10/min), so a
  // full match runs many minutes. Default is generous; settle() reverts "deadline passed" past it.
  settlementDeadlineSeconds: number;
  // 0G's block time is a rock-steady ~0.5s (≈2 blk/s, <1% drift over a week — measured), and the block
  // time (0.5s) is FINER than the 1s timestamp resolution, so a short runtime sample can't resolve it and
  // reads anywhere from 1–2 blk/s. That noise once halved a match's real deadline (→ "betting closed"
  // mid-match). So the rate is a fixed constant, not sampled. Assume slightly HIGH of the true ~2.03: real
  // betting time = seconds × (assumed / actual), so assumed ≥ actual guarantees the window never closes early.
  blocksPerSecond: number;
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

/**
 * Trailing debounce: coalesce a burst of bet-driven pool bumps into ONE push carrying the final book.
 * When the bots pile into a freshly-opened market (or a human fires a few quick bets), the relayer signals
 * once per bet; without this we'd re-read + rebroadcast the pools N times in a few hundred ms. `cancel`
 * drops a pending push at match teardown so it can't land after the settled snapshot.
 */
function debounced(fn: () => void, ms: number): { (): void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const call = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
  call.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return call;
}

export async function runOneMatch(hub: Hub, cfg: OrchestratorConfig, tts?: Tts): Promise<void> {
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

  // 3. Size the schedule from the block rate. 0G mines very fast, so a fixed "+N blocks" guess either
  //    reverts "open in past" (too small to outrun tx inclusion) or creates a long "betting not started"
  //    dead zone (too large). We DON'T sample the rate at runtime: 0G's ~0.5s block time is finer than
  //    its 1s timestamps, so a short sample reads a noisy 1–2 blk/s and once halved the real deadline. The
  //    true rate is a stable constant (cfg.blocksPerSecond ≈ the measured ~2.03; any tiny under-estimate is
  //    swamped by the ~90min deadline budget). "open in past" is still handled by the create retry below.
  //    Contract constants:
  //    MIN_BETTING_WINDOW=100, LOCK_BUFFER=5, MIN_MATCH_DURATION=25.
  const MIN_BETTING_WINDOW = 100, LOCK_BUFFER = 5, MIN_MATCH_DURATION = 25;
  const bps = cfg.blocksPerSecond;
  console.log(`[orch] assuming ${bps} blocks/sec (fixed — 0G block time is a stable ~0.5s)`);

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

  // Float the headline "which faction wins?" market once, at match start, before the first props
  // snapshot below — it's the match's CORE market (0=TOWN, 1=MAFIA; resolves from the verified run,
  // mistrial → Void), so unlike the side markets a failure to open it aborts the round (the retry layer
  // covers transient RPC hiccups). It isn't seeded by createMatch — every market is an on-demand prop.
  await rpc("openFactionMarket", async () => {
    const tx = await market.getFunction("openFactionMarket")(matchId);
    return tx.wait();
  });
  console.log(`[orch] 'which faction wins?' market opened on-chain matchId=${matchId}`);

  // Float the single "Who is the Mafia?" market once, at match start, so it's bettable for the whole
  // match (one outcome per seat; resolves to the Mafia seat from the revealed roles at settle()). Unlike
  // the faction market this is a side market — non-fatal: a miss just leaves this one market absent.
  try {
    await rpc("openMafiaSeatMarket", async () => {
      const tx = await market.getFunction("openMafiaSeatMarket")(matchId);
      return tx.wait();
    });
    console.log(`[orch] 'who is the mafia?' market opened on-chain matchId=${matchId}`);
  } catch (e) {
    console.warn(`[orch] openMafiaSeatMarket failed:`, (e as Error).message);
  }

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
  // alongside the faction-win market. createMatch makes 2 props — the round-1 RoundVotedOut market + the
  // round-1 NightKill market — and openVotedOutRound / openNightKillRound append a fresh market per later
  // round (so the two recurring kinds interleave), so the count GROWS during the match: read propCount each
  // pass and address markets by their (kind, param), never a fixed index. The on-chain `kind` byte is the
  // label authority (0 PlayerFate / 1 RoundVotedOut / 2 NightKill / 3 DetectiveClaim / 4 MafiaSeat / 5
  // Faction). The per-seat PlayerFate/survival market is NOT floated for now (createMatch no longer mints
  // it), so no PLAYER_FATE prop appears in this read; the on-demand singles (Faction, MafiaSeat,
  // DetectiveClaim) float at the tail.
  const PROP_KIND = { 0: "PLAYER_FATE", 1: "ROUND_VOTED_OUT", 2: "NIGHT_KILL", 3: "DETECTIVE_CLAIM", 4: "MAFIA_SEAT", 5: "FACTION" } as const;
  const readProps = async (): Promise<PropSnapshot[]> => {
    const count = Number(await rpc("propCount", () => market.getFunction("propCount")(matchId)));
    return Promise.all(
      Array.from({ length: count }, (_, i) =>
        rpc(`getProp:${i}`, () => market.getFunction("getProp")(matchId, i)).then((pr) => {
          const state = propStateOf(Number(pr.state));
          return {
            index: i,
            kind: PROP_KIND[Number(pr.kind) as 0 | 1 | 2 | 3 | 4 | 5] ?? "PLAYER_FATE",
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

  // Read the match's lifecycle state + every market's per-outcome pools. There is no bespoke faction pool
  // anymore — the faction verdict is the FACTION prop inside `props` (state/winningOutcome), like any market.
  const readPools = async () => {
    const [m, props] = await Promise.all([
      rpc("readPools", () => market.getFunction("matches")(matchId)),
      readProps(),
    ]);
    return { state: marketStateOf(Number(m.state)), props };
  };

  // Set only during the pre-match betting hold (below): the epoch ms the opening pause ends and the
  // first night falls. Woven into every OPEN push (the tick + pushPools) so the client's "first night
  // in Xs" countdown doesn't flicker between pushes. Undefined once the match is actually running.
  let preMatchEndsAt: number | undefined;

  const p0 = await readPools();
  hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: false, props: p0.props } });

  // 5a. Pre-open: the chain has NOT yet reached bettingOpenBlock, so bets would revert
  //     "betting not started". Hold the UI in a non-clickable pre-open state until it does.
  console.log(`[orch] sealing — waiting for chain to reach open block ${bettingOpenBlock}`);
  while ((await head()) < bettingOpenBlock) {
    const p = await readPools();
    hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: false, props: p.props } });
    await sleep(3000);
  }

  // 5b. Betting is now LIVE and STAYS OPEN until settle() — there is no block-based close and no
  //     lock step. The market accepts wagers right through the match; only settlement closes it.
  //     We emit no `closesAt`, so the UI shows an open market with no countdown.
  console.log(`[orch] betting LIVE — open until settled`);
  {
    const p = await readPools();
    hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: true, props: p.props } });
  }

  // Live pools are pushed the instant a bet lands (the relayer → poolSignal → pushPoolsSoon path set up
  // below), so this background tick is only a BACKSTOP: it catches a direct-wallet bet that skipped the
  // relayer, or a signal we somehow missed, and keeps the "first night in Xs" countdown fresh. Because the
  // real-time path carries the load, this can run slow (10s) — net RPC reads go DOWN vs the old 4s poll.
  // Cleared right before settlement.
  const poolTick = setInterval(() => {
    void (async () => {
      try {
        const p = await readPools();
        hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: true, ...(preMatchEndsAt ? { preMatchEndsAt } : {}), props: p.props } });
      } catch {
        /* transient RPC read; next tick retries */
      }
    })();
  }, 10_000);

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
    hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: true, ...(preMatchEndsAt ? { preMatchEndsAt } : {}), props: p.props } });
  };

  // Real-time odds: the relayer nudges us the instant a sponsored bet for this match lands, so the book
  // updates as fast as the bet mines (~0.5s on 0G) rather than on the 10s backstop tick. Debounced so a
  // burst (the bots piling into a fresh market) collapses into one push of the final pools. Unregistered
  // + cancelled at teardown so a late bump can't rebroadcast an OPEN book after the settled snapshot.
  const pushPoolsSoon = debounced(() => {
    void pushPools().catch(() => {
      /* transient read; the backstop tick retries */
    });
  }, 250);
  const unregisterPoolSignal = cfg.poolSignal?.register(matchId, pushPoolsSoon);

  // The two RECURRING per-round markets — "voted out" (the day vote) and "night kill" (before dawn).
  // createMatch floats round 1 for both; as the match advances we open each new round's pair (so they're
  // bettable while that round plays) and freeze each once its outcome is public: a VotedOut market when
  // the round's DAY VOTE has resolved, a NightKill market at DAWN (the moment the night's kill is public,
  // so the night's dead zone is the betting window). The two kinds INTERLEAVE in the prop array as they
  // open, so there is no index formula — each market is addressed by its (kind, param) read off-chain.
  let votedOutOpened = 1; // round-1 markets created in createMatch
  let nightKillOpened = 1;
  const voFrozen = new Set<number>(); // rounds whose VotedOut market we've already closed
  const nkFrozen = new Set<number>(); // rounds whose NightKill market we've already closed
  const openRound = async (
    fn: "openVotedOutRound" | "openNightKillRound",
    round: number,
    label: string,
  ): Promise<boolean> => {
    try {
      await rpc(`${fn}:${round}`, async () => {
        const tx = await market.getFunction(fn)(matchId);
        return tx.wait();
      });
      console.log(`[orch] '${label}' round ${round} market opened on-chain matchId=${matchId}`);
      return true;
    } catch (e) {
      console.warn(`[orch] ${fn} ${round} failed:`, (e as Error).message);
      return false;
    }
  };
  const syncRoundMarkets = async (state: { round: number; phase: "night" | "day"; winner: unknown }): Promise<void> => {
    const over = state.winner != null;
    const cur = state.round; // 1-based current round
    let changed = false;

    // 1. Open each round's markets as the match reaches it (both float at the round's nightfall). Never
    //    ahead of play, and never once the match is over. Sequential; a failure just retries next turn.
    if (!over) {
      while (votedOutOpened < cur) {
        if (!(await openRound("openVotedOutRound", votedOutOpened + 1, "voted out"))) break;
        votedOutOpened++;
        changed = true;
      }
      while (nightKillOpened < cur) {
        if (!(await openRound("openNightKillRound", nightKillOpened + 1, "night kill"))) break;
        nightKillOpened++;
        changed = true;
      }
    }

    // 2. Which markets are due to freeze — VotedOut R once its DAY vote resolved (the match moved past
    //    round R), NightKill R at DAWN (night R has resolved). Timing lives in ./round-markets predicates.
    const voDue: number[] = [];
    for (let r = 1; r <= votedOutOpened; r++) if (votedOutResolved(state, r) && !voFrozen.has(r)) voDue.push(r);
    const nkDue: number[] = [];
    for (let r = 1; r <= nightKillOpened; r++) if (nightKillResolved(state, r) && !nkFrozen.has(r)) nkDue.push(r);

    // 3. Freeze the due markets. Look each up by (kind, param) from a fresh props read — the two kinds
    //    interleave, so there is no index formula. Only read when there's actually something to close.
    if (voDue.length || nkDue.length) {
      const props = await readProps();
      const idxOf = (kind: string, param: number) => props.find((p) => p.kind === kind && p.param === param)?.index;
      for (const r of voDue) {
        const i = idxOf("ROUND_VOTED_OUT", r);
        if (i == null) continue; // not in this (transient) read → retry next turn
        if (await freeze(i, `voted-out:r${r}`)) changed = true;
        voFrozen.add(r);
      }
      for (const r of nkDue) {
        const i = idxOf("NIGHT_KILL", r);
        if (i == null) continue;
        if (await freeze(i, `night-kill:r${r}`)) changed = true;
        nkFrozen.add(r);
      }
    }

    if (changed) await pushPools();
  };

  // The single "Detective claim: real or bluff?" market — floated on the FIRST public claim of the match
  // (a Detective reveal or a Mafia fake-claim). At most one per match: a later counter-claim renders as
  // its own beat but reuses this pool (money moves toward BLUFF). Resolves from the revealed roles at
  // settle(), so opening it adds no trust — it only creates the wagering surface. Non-fatal on failure.
  let detectiveClaimOpened = false;
  const claimedSeats = new Set<number>(); // seats that have ALREADY gone public as the Detective this match
  let detectiveWindowShown = false;       // the "real or bluff?" spotlight is a ONCE-per-match beat
  const openDetectiveClaim = async (seat: number): Promise<void> => {
    if (detectiveClaimOpened) return;
    detectiveClaimOpened = true; // guard even if the tx is in flight, so a same-turn double never races
    try {
      await rpc("openDetectiveClaim", async () => {
        const tx = await market.getFunction("openDetectiveClaim")(matchId, seat);
        return tx.wait();
      });
      console.log(`[orch] 'detective claim' market opened on-chain seat=${seat} matchId=${matchId}`);
      await pushPools();
    } catch (e) {
      detectiveClaimOpened = false; // let a later claim retry — the market never opened
      console.warn(`[orch] openDetectiveClaim seat=${seat} failed:`, (e as Error).message);
    }
  };

  // ── voice-paced stage emission ────────────────────────────────────────────────────────────────
  // Beats are released to the stage at the speed they can actually be WATCHED, not the speed they are
  // inferred — otherwise a slow ElevenLabs line (~10s) against a fast emit cadence makes the viewer
  // fall behind and voices get cut off. The pipeline the user asked for:
  //   infer(N) → synth(N) (warms the clip the client will play) → wait out beat N-1's playback → emit N
  //   → return immediately so infer(N+1) runs IN PARALLEL with watching N.
  // Because playMatch awaits the hook, returning right after `emit` (not after the playback elapses) is
  // what lets the next inference overlap the current beat — the synth/infer of N+1 hide under N's audio.
  const personaName = (seat: number) => personas.find((p) => p.seat === seat)?.name ?? `Seat ${seat}`;
  const personaBlurb = (seat: number) => personas.find((p) => p.seat === seat)?.blurb;
  // The spoken line behind a beat (null for night/dawn narration, which carries no audio).
  const speechLineFor = (m: WsMessage): ToneInput | null => {
    if (m.type === "discussion" || m.type === "claim")
      return { text: m.speech, name: personaName(m.seat), blurb: personaBlurb(m.seat), kind: "discussion" };
    if (m.type === "turn") {
      const d = m.turn.decision;
      return {
        text: m.turn.speech,
        name: personaName(m.turn.seat),
        blurb: personaBlurb(m.turn.seat),
        kind: "vote",
        targetName: d.action === "vote" ? personaName(d.target) : null,
      };
    }
    return null;
  };
  const AUDIO_TAIL_MS = Number(process.env.TTS_TAIL_MS ?? 1200); // a breath after a line, matches the client
  const NARRATION_PACE_MS = Number(process.env.NARRATION_PACE_MS ?? 8000); // night/dawn (no audio) read time
  const SYNTH_TIMEOUT_MS = Number(process.env.TTS_SYNTH_TIMEOUT_MS ?? 8000); // never let a slow synth stall
  // How long this beat will occupy the stage — the real audio length when we can synth it, else a text
  // estimate, else a fixed narration read. Synthesizing here ALSO warms the client's clip cache.
  const playbackMsFor = async (line: ToneInput | null): Promise<number> => {
    if (!line) return NARRATION_PACE_MS;
    if (tts?.enabled) {
      try {
        return (await withTimeout(tts.durationMs(line), SYNTH_TIMEOUT_MS)) + AUDIO_TAIL_MS;
      } catch (e) {
        console.warn(`[orch] tts duration fell back to a text estimate: ${(e as Error).message}`);
      }
    }
    return estimateSpeechMs(line.text) + AUDIO_TAIL_MS;
  };
  let freeAt = 0; // wall-clock at which the previous beat finishes playing on the stage
  const emitPaced = async (m: WsMessage): Promise<void> => {
    const dur = await playbackMsFor(speechLineFor(m)); // synth runs here, overlapping the prior playback
    const wait = freeAt - Date.now();
    if (wait > 0) await sleep(wait); // hold until the previous beat has finished on the stage
    hub.broadcast(m); // the client now shows this beat's text alongside its (pre-warmed) audio
    freeAt = Date.now() + dur; // the next beat waits out THIS beat's playback
  };

  // ── synchronized in-loop betting windows ───────────────────────────────────────────────────────
  // The whole point of this feature: at a dramatic beat, PAUSE the stream and spotlight ONE side market
  // so "a market exists" becomes "a betting MOMENT". The window is emitted as a `bet_window` beat (so the
  // stage plays it in-line with the dialogue and counts down to `endsAt`) AND the loop actually holds for
  // its duration — that hold is what gives spectators room to wager. We freeze the prop on-chain the instant
  // the window closes: for the round markets that's BEFORE the outcome is revealed (the vote is cast / dawn
  // breaks), so there is no last-look on a decided market; for DetectiveClaim the outcome stays hidden until
  // the reveal, so freezing there simply shuts betting when the timer stops (payout still comes from settle).
  const WINDOW_MS = {
    NIGHT_KILL: cfg.nightKillWindowSeconds * 1000,
    ROUND_VOTED_OUT: cfg.votedOutWindowSeconds * 1000,
    DETECTIVE_CLAIM: cfg.detectiveClaimWindowSeconds * 1000,
  } as const;
  // Address a market by its (kind, param) off a fresh read — the recurring kinds interleave, so there is
  // no index formula. DetectiveClaim is looked up by kind alone (there is at most one per match).
  const findPropIdx = async (kind: PropSnapshot["kind"], param?: number): Promise<PropSnapshot | undefined> => {
    const props = await readProps();
    return props.find((p) => p.kind === kind && (param == null || p.param === param));
  };
  // Thin wrapper over the pure `runBetWindow` (server/src/bet-windows.ts): thread the pacing cursor and
  // inject the chain/broadcast deps. Advancing `freeAt` here keeps the window in lockstep with emitPaced.
  const runBetWindow = async (
    market: BetWindowMarket,
    round: number,
    prop: PropSnapshot,
    opts: { freezeOnClose: boolean; seat?: number },
  ): Promise<void> => {
    const durationMs = WINDOW_MS[market];
    if (durationMs > 0)
      console.log(`[orch] bet window '${market}' round=${round} prop=${prop.index} for ${Math.round(durationMs / 1000)}s`);
    freeAt = await runBetWindowFn(
      { broadcast: (m) => hub.broadcast(m), pushPools, freeze, sleep, now: Date.now },
      { market, round, propIndex: prop.index, durationMs, freezeOnClose: opts.freezeOnClose, seat: opts.seat, freeAt },
    );
  };

  // ── pre-match betting hold ──────────────────────────────────────────────────────────────────────
  // Betting just went live, but the loop would otherwise cut straight to nightfall — so a fresh round
  // reads as a one-second flash of "The court" before the first night, and it's unclear a NEW match has
  // begun. Hold here on the freshly-convened court (new bench, new personas) with a visible countdown:
  // it gives spectators real time to back the headline FACTION / "who is the Mafia?" markets AND makes
  // the start of a new match unmistakable. The client shows THE COURT + "first night in Xs"; when it
  // elapses the match begins (the first night beat lands as the countdown hits zero). 0 disables it.
  if (cfg.preMatchBettingSeconds > 0) {
    preMatchEndsAt = Date.now() + cfg.preMatchBettingSeconds * 1000;
    console.log(`[orch] pre-match betting hold ${cfg.preMatchBettingSeconds}s — court convenes`);
    await pushPools(); // stamp the countdown immediately (don't wait for the next 4s tick)
    await sleep(cfg.preMatchBettingSeconds * 1000);
    preMatchEndsAt = undefined;
    await pushPools(); // clear the countdown on the client right as the match begins
  }

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
          // Count of lives shielded in the just-resolved night (a blocked kill). Anonymous — the
          // gate puts only the COUNT on the dawn beat, never the seat, so the Doctor never leaks.
          state.lastNight?.saved.length ?? 0,
        );
        for (const m of msgs) await emitPaced(m);
        // The recurring per-round markets ("voted out" + "night kill") open each new round's pair and
        // freeze already-resolved ones as the match advances (VotedOut at its day vote, NightKill at dawn).
        await syncRoundMarkets(state);
      },
      // Daytime deliberation streams as-is: it is public day speech (the discussion pass never runs
      // at night), so no role can leak. Paced by its spoken duration so the stage can keep up.
      onDiscussion: async (entry, state) => {
        // A Detective reveal / Mafia fake-claim is promoted to its own labeled `claim` beat + scene, but
        // ONLY the first time a given seat goes public. Enforce "one Detective claim per match": a repeat
        // by an already-claimed seat (e.g. a Mafia bluffing the Detective two rounds running) is not a new
        // event — it streams as ordinary deliberation, never re-opening the market. See classifyDetectiveClaim.
        const decision = classifyDetectiveClaim(claimedSeats, detectiveWindowShown, entry.seat, entry.claim);
        if (decision.claim) {
          claimedSeats.add(entry.seat);
          await emitPaced({ type: "claim", seat: entry.seat, round: entry.round, role: "DETECTIVE", counter: decision.counter, speech: entry.speech, state: toPublicState(state) });
          await openDetectiveClaim(entry.seat); // self-guards: only the first claim opens the market
          // Pause on the FIRST claim: spotlight the "real or bluff?" market, once per match. A later rival
          // claim reuses the SAME market (param == the first claimant), so re-running the window would just
          // "reopen" an already-shown market — decision.showWindow is false for it. Freeze on close like the
          // other windows so the market shuts when its timer stops (freezing only refuses new stakes; the
          // outcome still resolves from the revealed roles at settle, so this leaks nothing mid-match).
          if (decision.showWindow) {
            const prop = await findPropIdx("DETECTIVE_CLAIM");
            if (prop) {
              detectiveWindowShown = true;
              await runBetWindow("DETECTIVE_CLAIM", entry.round, prop, { freezeOnClose: true, seat: prop.param });
            }
          }
        } else {
          await emitPaced({ type: "discussion", seat: entry.seat, round: entry.round, speech: entry.speech, state: toPublicState(state) });
        }
      },
      // Nightfall: narrate it HERE (claim the gate's night beat so it isn't emitted twice in onTurn),
      // then open the "who dies tonight?" window and freeze it before the night resolves — so the betting
      // window IS the night's dead zone and the market closes before dawn ever names the fallen.
      onNightfall: async (round) => {
        gate.announcedNightRound = round; // pre-claim so gateTurn skips its own `night` push this round
        await emitPaced({ type: "night", round });
        const prop = await findPropIdx("NIGHT_KILL", round); // opened by createMatch (R1) / syncRoundMarkets (later)
        if (prop) await runBetWindow("NIGHT_KILL", round, prop, { freezeOnClose: true });
      },
      // After the floor has spoken and before the first vote lands: open the "who hangs this round?" window
      // and freeze it as voting begins, so nobody can bet a plurality that's already forming in the tally.
      onPreVote: async (round) => {
        const prop = await findPropIdx("ROUND_VOTED_OUT", round);
        if (prop) await runBetWindow("ROUND_VOTED_OUT", round, prop, { freezeOnClose: true });
      },
    });
  } finally {
    // Stop the live pool ticker AND the bet-driven real-time push — betting closes via settle() next (or
    // the match was abandoned). Cancelling both here guarantees no stray OPEN snapshot lands during the
    // reveal/settle sequence and flips the client back off the settled board.
    clearInterval(poolTick);
    pushPoolsSoon.cancel();
    unregisterPoolSignal?.();
  }

  // 7b. Close EVERY market still open BEFORE the masks come off — the reveal decides the FACTION verdict,
  //     "who is the Mafia?", any Detective claim and every survivor's fate at once, so a still-open market
  //     would be a riskless last-look on a known outcome. The recurring/per-seat markets already froze as
  //     they resolved mid-match; this sweeps whatever remains so the reveal lands on a board that is
  //     already shut. Idempotent (already-frozen props are skipped) and payout-neutral — resolution still
  //     comes from the verified run at settle(). Push the closed snapshot FIRST so the client's betting
  //     gate flips shut ahead of the reveal beat.
  try {
    let closedAtVerdict = false;
    for (const p of await readProps()) {
      if (await freeze(p.index, "verdict")) closedAtVerdict = true;
    }
    if (closedAtVerdict) await pushPools();
  } catch (e) {
    // Non-fatal: settle() still resolves every market and the client gate (open && !playbackComplete)
    // covers the reveal — a hiccup here must never abort the match before it can settle.
    console.warn(`[orch] pre-reveal market close skipped:`, (e as Error).message);
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

  // 10. Push the final market snapshot + a settled marker. Every market's resolution — the FACTION
  //     verdict (RESOLVED to TOWN/MAFIA, or VOID on a mistrial / an unbacked winner → full refund) and
  //     every side market — rides in the snapshot's props, so the UI derives the verdict from there and
  //     guides bettors to reclaim via claimProp/refundProp.
  const pf = await readPools();
  const faction = pf.props.find((p) => p.kind === "FACTION");
  hub.broadcast({ type: "market", market: { state: "SETTLED", props: pf.props } });
  hub.broadcast({
    type: "settled",
    txHash: settleRcpt?.hash,
    transcriptCID: transcriptCID === ZeroHash ? undefined : transcriptCID,
  });
  const verdict = faction?.state === "VOID" ? "VOID(mistrial/unbacked)"
    : faction?.winningOutcome === 1 ? "MAFIA" : faction?.winningOutcome === 0 ? "TOWN" : "?";
  console.log(`[orch] settled matchId=${matchId} faction=${verdict} tx=${settleRcpt?.hash}`);
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
      // without spending gas. Otherwise flip it so stakes become refundable right now. Bets now live in
      // the per-market props (there's no match-level pool), so scan them for any stake.
      const propCount = Number(await market.getFunction("propCount")(matchId));
      let hasBets = false;
      for (let i = 0; i < propCount && !hasBets; i++) {
        const pr = await market.getFunction("getProp")(matchId, i);
        if ((pr.pools as bigint[]).some((p) => p > 0n)) hasBets = true;
      }
      if (!hasBets) {
        pending.delete(matchId);
        continue;
      }
      const tx = await market.getFunction("enterRefundMode")(matchId);
      await tx.wait();
      pending.delete(matchId);
      console.log(`[orch] abandoned matchId=${matchId} past deadline → RefundMode; bettors can refundProp()`);
    } catch (e) {
      // Leave it in `pending` so a later sweep retries; refund stays available on-chain regardless.
      console.warn(`[orch] sweep matchId=${matchId} failed:`, (e as Error).message);
    }
  }
}
