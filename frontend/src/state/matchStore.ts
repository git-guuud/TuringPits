/**
 * The match store. The reducer ingests the live `WsMessage` stream into an ordered list of BEATS —
 * the unit of playback. A beat is one of:
 *   - `night`  : nightfall (no actor, no action, no speech — the night is opaque by design)
 *   - `dawn`   : first light, carrying only the publicly-known death(s)
 *   - `turn`   : a day vote (public, attributable testimony)
 * Night actions are NEVER on the wire (see server/src/orchestrator.ts), so a role can't leak from
 * the stream. The view renders beats one at a time behind a PLAYBACK CURSOR that the Court advances
 * only once the current beat has finished typing — so nothing is ever truncated, at the live pace
 * or when a late joiner receives the whole buffer at once. Every match-progress field the panels
 * render (seats, phase, eliminations, reveal) is DERIVED from the cursor, keeping the bench, the
 * stage and the evidence rail in lockstep.
 *
 * The market (pools / state / winning side) is pushed by the server (read from the deployed
 * contract) and rendered truthfully/immediately — it is money, not narrative. The connected
 * wallet's own stake, balance, and the bet/claim transactions go straight to the contract via
 * `lib/contract.ts`.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { createFeed } from "../lib/feed.js";
import {
  claimPayout,
  connectWallet,
  getBalance,
  humanizeTxError,
  placeBet as placeBetTx,
  readMarketState,
  readMyStakes,
  refundStake,
} from "../lib/contract.js";
import type { Wallet } from "../lib/contract.js";
import type {
  ConnStatus,
  Faction,
  MarketSnapshot,
  Persona,
  Phase,
  PublicSeat,
  PublicTurn,
  RecordCommit,
  Role,
  Side,
  WsMessage,
} from "../lib/types.js";

/** One unit of playback. `seats` is the alive/dead snapshot to render while this beat is on stage. */
export type Beat =
  | { kind: "night"; round: number; seats: PublicSeat[] }
  | { kind: "dawn"; round: number; killed: number[]; seats: PublicSeat[] }
  | { kind: "discussion"; seat: number; round: number; speech: string; seats: PublicSeat[] }
  | { kind: "turn"; turn: PublicTurn; round: number; phase: Phase; seats: PublicSeat[] };

export interface WalletState {
  account: string | null;
  status: "idle" | "connecting" | "connected" | "error";
  /** Native 0G balance as a decimal string; undefined until first read. */
  balance?: string;
  error?: string;
}

export interface MyStakes {
  yes: string;
  no: string;
  claimed: boolean;
}

export interface TxState {
  pending: boolean;
  error?: string;
  lastHash?: string;
}

export interface ViewState {
  isMock: boolean;
  nonce: string | null;
  personas: Persona[];
  record: RecordCommit | null;
  marketAddress: string | null;
  matchId: number | null;
  chainId: number | null;
  market: MarketSnapshot;
  transcriptCID: string | null;
  /** Draw-outcome fee (basis points), from the settled message — for the refund estimate. */
  feeBpsDraw: number | null;
  wallet: WalletState;
  stakes: MyStakes;
  tx: TxState;

  // ── raw ingest (every beat received, in order) ──
  beats: Beat[];
  rawReveal: { roles: Role[]; winner: Faction } | null;

  // ── playback ──
  /** Index of the beat currently on the stage; -1 before the first beat is shown. */
  cursor: number;
  /** True once the final beat has finished typing — gates the reveal/sentence scenes. */
  playbackComplete: boolean;

  // ── DERIVED from the cursor (what the panels render) ──
  seats: PublicSeat[];
  phase: Phase | null;
  round: number;
  winner: Faction | null;
  speakingSeat: number | null;
  currentBeat: Beat | null;
  currentTurn: PublicTurn | null;
  attestedCount: number;
  reveal: { roles: Role[]; winner: Faction } | null;
  /** Live day-vote tally for the active round: seat id → votes received so far (up to the cursor). */
  votes: Record<number, number>;

  // ── connection / liveness ──
  connection: ConnStatus;
}

const initialMarket: MarketSnapshot = { state: "OPEN", bettingLive: false, yesPool: "0", noPool: "0" };

const baseState: ViewState = {
  isMock: false,
  nonce: null,
  personas: [],
  record: null,
  marketAddress: null,
  matchId: null,
  chainId: null,
  market: initialMarket,
  transcriptCID: null,
  feeBpsDraw: null,
  wallet: { account: null, status: "idle" },
  stakes: { yes: "0", no: "0", claimed: false },
  tx: { pending: false },
  beats: [],
  rawReveal: null,
  cursor: -1,
  playbackComplete: false,
  seats: [],
  phase: null,
  round: 0,
  winner: null,
  speakingSeat: null,
  currentBeat: null,
  currentTurn: null,
  attestedCount: 0,
  reveal: null,
  votes: {},
  connection: "connecting",
};

type Action =
  | { kind: "ws"; msg: WsMessage }
  | { kind: "advance" }
  | { kind: "connection"; status: ConnStatus }
  | { kind: "wallet"; wallet: WalletState }
  | { kind: "stakes"; stakes: MyStakes }
  | { kind: "tx"; tx: TxState };

/** All-alive seats from the persona roster (the state before any beat). */
function freshSeats(personas: Persona[]): PublicSeat[] {
  return personas.map((p) => ({ id: p.seat, alive: true }));
}

/** The alive/dead snapshot to carry into a beat that doesn't change it (e.g. nightfall). */
function carrySeats(state: ViewState): PublicSeat[] {
  const last = state.beats[state.beats.length - 1];
  return last ? last.seats : freshSeats(state.personas);
}

/** Append a beat, showing the first one as soon as it lands. */
function pushBeat(state: ViewState, beat: Beat): ViewState {
  return project({ ...state, beats: [...state.beats, beat], cursor: state.cursor === -1 ? 0 : state.cursor });
}

/** Recompute every cursor-derived field. Called whenever the cursor or the beats change. */
function project(s: ViewState): ViewState {
  const c = s.cursor;
  const beat = c >= 0 ? s.beats[c] : undefined;
  const seats = beat ? beat.seats : freshSeats(s.personas);
  const currentBeat = beat ?? null;
  const currentTurn = beat && beat.kind === "turn" ? beat.turn : null;
  // The seat on the floor — a day vote, or an unsigned deliberation contribution.
  const speaker = beat?.kind === "turn" ? beat.turn.seat : beat?.kind === "discussion" ? beat.seat : null;
  const phase: Phase | null = beat
    ? beat.kind === "night"
      ? "night"
      : beat.kind === "dawn" || beat.kind === "discussion"
        ? "day"
        : beat.phase
    : null;
  const reveal = s.playbackComplete ? s.rawReveal : null;

  // attested day testimonies shown so far (night/dawn carry no signed move).
  let attested = 0;
  for (let i = 0; i <= c; i++) if (s.beats[i]?.kind === "turn") attested++;

  // Live vote tally for the active round: who has drawn votes in the day votes shown so far. It is
  // empty during night/dawn (no turn beats of that round yet), so it naturally appears only on the
  // floor and resets each new round.
  const activeRound = beat ? beat.round : 0;
  const votes: Record<number, number> = {};
  for (let i = 0; i <= c; i++) {
    const b = s.beats[i];
    if (b?.kind === "turn" && b.round === activeRound && b.turn.decision.action === "vote") {
      votes[b.turn.decision.target] = (votes[b.turn.decision.target] ?? 0) + 1;
    }
  }

  return {
    ...s,
    seats,
    phase,
    round: beat ? beat.round : 0,
    winner: reveal?.winner ?? null,
    speakingSeat: speaker != null && !s.playbackComplete ? speaker : null,
    currentBeat,
    currentTurn,
    attestedCount: attested,
    reveal,
    votes,
  };
}

function reduce(state: ViewState, action: Action): ViewState {
  if (action.kind === "wallet") return { ...state, wallet: action.wallet };
  if (action.kind === "stakes") return { ...state, stakes: action.stakes };
  if (action.kind === "tx") return { ...state, tx: action.tx };
  if (action.kind === "connection") return { ...state, connection: action.status };

  if (action.kind === "advance") {
    if (state.cursor < state.beats.length - 1) return project({ ...state, cursor: state.cursor + 1 });
    if (!state.playbackComplete && state.rawReveal) return project({ ...state, playbackComplete: true });
    return state;
  }

  const msg = action.msg;
  switch (msg.type) {
    case "match_init":
      return project({
        ...baseState,
        // preserve a live wallet connection across a new match
        wallet: state.wallet,
        isMock: msg.isMock,
        nonce: msg.nonce,
        personas: msg.personas,
        record: msg.record,
        marketAddress: msg.marketAddress,
        matchId: msg.matchId,
        chainId: msg.chainId,
      });

    case "market":
      return project({ ...state, market: msg.market });

    case "night":
      return pushBeat(state, { kind: "night", round: msg.round, seats: carrySeats(state) });

    case "dawn":
      return pushBeat(state, { kind: "dawn", round: msg.round, killed: msg.killed, seats: [...msg.state.players] });

    case "discussion":
      return pushBeat(state, {
        kind: "discussion",
        seat: msg.seat,
        round: msg.round,
        speech: msg.speech,
        seats: [...msg.state.players],
      });

    case "turn":
      // Defense-in-depth against role leaks: a night turn names the actor + its action
      // (kill/save/investigate), exposing Mafia/Doctor/Detective mid-match. The server's night
      // gate already strips these (server/src/night.ts); drop any that slip through so a server
      // regression can never surface a night action before the end-of-match reveal.
      if (msg.turn.decision.phase === "night") return state;
      return pushBeat(state, {
        kind: "turn",
        turn: msg.turn,
        round: msg.turn.decision.round,
        phase: msg.turn.decision.phase,
        seats: [...msg.state.players],
      });

    case "reveal":
      return project({ ...state, rawReveal: { roles: msg.roles, winner: msg.winner } });

    case "settled":
      return project({
        ...state,
        transcriptCID: msg.transcriptCID ?? state.transcriptCID,
        feeBpsDraw: msg.feeBpsDraw ?? state.feeBpsDraw,
        market: { ...state.market, state: "SETTLED", outcome: msg.outcome, winningSide: msg.winningSide },
      });

    default:
      return state;
  }
}

export interface MatchApi {
  state: ViewState;
  connect: () => Promise<void>;
  placeBet: (side: Side, amount: string) => Promise<void>;
  claim: () => Promise<void>;
  /** Reclaim stake from a match in RefundMode (host never settled). */
  refund: () => Promise<void>;
  /** Advance the playback cursor to the next beat (called by the Court once a beat finishes). */
  advance: () => void;
}

export function useMatch(): MatchApi {
  const [state, dispatch] = useReducer(reduce, baseState);

  // Non-render refs the async wallet actions need without re-subscribing the feed.
  const walletRef = useRef<Wallet | null>(null);
  const addrRef = useRef<string | null>(null);
  addrRef.current = state.marketAddress;
  const matchIdRef = useRef<number | null>(null);
  matchIdRef.current = state.matchId;

  const refreshStakes = useCallback(async () => {
    if (!walletRef.current || !addrRef.current || matchIdRef.current == null) return;
    try {
      const stakes = await readMyStakes(addrRef.current, matchIdRef.current, walletRef.current);
      dispatch({ kind: "stakes", stakes });
    } catch {
      /* read failures are non-fatal; pools still come over WS */
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!walletRef.current) return;
    try {
      const balance = await getBalance(walletRef.current);
      dispatch({ kind: "wallet", wallet: { account: walletRef.current.account, status: "connected", balance } });
    } catch {
      /* balance is display-only; ignore read failures */
    }
  }, []);

  useEffect(() => {
    const feed = createFeed();
    const unsub = feed.subscribe((msg) => {
      dispatch({ kind: "ws", msg });
      // refresh the wallet's own stake when the market opens or settles
      if (msg.type === "match_init" || msg.type === "settled") void refreshStakes();
    });
    const unsubStatus = feed.onStatus?.((status) => dispatch({ kind: "connection", status }));
    feed.start?.();
    return () => {
      unsub();
      unsubStatus?.();
    };
  }, [refreshStakes]);

  // Liveness fallback: while the match is LOCKED the server normally pushes the settlement. If it
  // stops (crashed, or the match was moved into RefundMode on-chain after the deadline), poll the
  // contract directly so the terminal state still surfaces and bettors can claim/refund.
  useEffect(() => {
    if (state.market.state !== "LOCKED") return;
    const address = state.marketAddress;
    const matchId = state.matchId;
    if (!address || matchId == null) return;
    let stop = false;
    const tick = async () => {
      try {
        const m = await readMarketState(address, matchId);
        if (stop) return;
        if (m.state === "SETTLED" && m.outcome) {
          dispatch({ kind: "ws", msg: { type: "settled", outcome: m.outcome, winningSide: m.winningSide, feeBpsDraw: m.feeBpsDraw } });
          void refreshStakes();
        } else if (m.state === "REFUND") {
          dispatch({ kind: "ws", msg: { type: "market", market: { state: "REFUND", yesPool: m.yesPool, noPool: m.noPool } } });
          void refreshStakes();
        }
      } catch {
        /* transient RPC failure; try again next tick */
      }
    };
    const id = setInterval(tick, 15000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [state.market.state, state.marketAddress, state.matchId, refreshStakes]);

  const connect = useCallback(async () => {
    dispatch({ kind: "wallet", wallet: { account: null, status: "connecting" } });
    try {
      const w = await connectWallet();
      walletRef.current = w;
      dispatch({ kind: "wallet", wallet: { account: w.account, status: "connected" } });
      await Promise.all([refreshStakes(), refreshBalance()]);
    } catch (e) {
      dispatch({ kind: "wallet", wallet: { account: null, status: "error", error: humanizeTxError(e) } });
    }
  }, [refreshStakes, refreshBalance]);

  const placeBet = useCallback(
    async (side: Side, amount: string) => {
      if (!walletRef.current) {
        await connect();
        if (!walletRef.current) return;
      }
      const address = addrRef.current;
      const matchId = matchIdRef.current;
      if (!address || matchId == null) {
        dispatch({ kind: "tx", tx: { pending: false, error: "No market/match id from server yet." } });
        return;
      }
      dispatch({ kind: "tx", tx: { pending: true } });
      try {
        const hash = await placeBetTx(address, matchId, walletRef.current, side, amount);
        dispatch({ kind: "tx", tx: { pending: false, lastHash: hash } });
        await Promise.all([refreshStakes(), refreshBalance()]);
      } catch (e) {
        dispatch({ kind: "tx", tx: { pending: false, error: humanizeTxError(e) } });
      }
    },
    [connect, refreshStakes, refreshBalance],
  );

  const claim = useCallback(async () => {
    if (!walletRef.current || !addrRef.current || matchIdRef.current == null) return;
    dispatch({ kind: "tx", tx: { pending: true } });
    try {
      const hash = await claimPayout(addrRef.current, matchIdRef.current, walletRef.current);
      dispatch({ kind: "tx", tx: { pending: false, lastHash: hash } });
      await Promise.all([refreshStakes(), refreshBalance()]);
    } catch (e) {
      dispatch({ kind: "tx", tx: { pending: false, error: humanizeTxError(e) } });
    }
  }, [refreshStakes, refreshBalance]);

  const refund = useCallback(async () => {
    if (!walletRef.current || !addrRef.current || matchIdRef.current == null) return;
    dispatch({ kind: "tx", tx: { pending: true } });
    try {
      const hash = await refundStake(addrRef.current, matchIdRef.current, walletRef.current);
      dispatch({ kind: "tx", tx: { pending: false, lastHash: hash } });
      await Promise.all([refreshStakes(), refreshBalance()]);
    } catch (e) {
      dispatch({ kind: "tx", tx: { pending: false, error: humanizeTxError(e) } });
    }
  }, [refreshStakes, refreshBalance]);

  const advance = useCallback(() => dispatch({ kind: "advance" }), []);

  return { state, connect, placeBet, claim, refund, advance };
}
