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
import { nightKillResolved, votedOutResolved } from "./round-markets.js";
import { buildPersonas, buildProvider, runMatch } from "./match-runner.js";
import type { Hub } from "./broadcast.js";
import type { PropSnapshot, WsMessage } from "./wire.js";
import { estimateSpeechMs, type Tts, type ToneInput } from "./tts.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  // alongside the faction-win market. createMatch makes n+2 props — PlayerFate (propIdx 0..n-1) + the
  // round-1 RoundVotedOut market + the round-1 NightKill market — and openVotedOutRound / openNightKillRound
  // append a fresh market per later round (so the two recurring kinds interleave), so the count GROWS
  // during the match: read propCount each pass and address markets by their (kind, param), never a fixed
  // index. The on-chain `kind` byte is the label authority (0 PlayerFate / 1 RoundVotedOut / 2 NightKill).
  const PROP_KIND = { 0: "PLAYER_FATE", 1: "ROUND_VOTED_OUT", 2: "NIGHT_KILL" } as const;
  const readProps = async (): Promise<PropSnapshot[]> => {
    const count = Number(await rpc("propCount", () => market.getFunction("propCount")(matchId)));
    return Promise.all(
      Array.from({ length: count }, (_, i) =>
        rpc(`getProp:${i}`, () => market.getFunction("getProp")(matchId, i)).then((pr) => {
          const state = propStateOf(Number(pr.state));
          return {
            index: i,
            kind: PROP_KIND[Number(pr.kind) as 0 | 1 | 2] ?? "PLAYER_FATE",
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
    if (m.type === "discussion")
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
        // After the public death beat lands, freeze the fallen seat's player-fate market on-chain.
        await closeFallenProps(state);
        // The recurring per-round markets ("voted out" + "night kill") open each new round's pair and
        // freeze already-resolved ones as the match advances (VotedOut at its day vote, NightKill at dawn).
        await syncRoundMarkets(state);
      },
      // Daytime deliberation streams as-is: it is public day speech (the discussion pass never runs
      // at night), so no role can leak. Paced by its spoken duration so the stage can keep up.
      onDiscussion: async (entry, state) => {
        await emitPaced({ type: "discussion", seat: entry.seat, round: entry.round, speech: entry.speech, state: toPublicState(state) });
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
