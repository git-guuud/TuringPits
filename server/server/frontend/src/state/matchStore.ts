/**
 * The match store. The reducer turns the live `WsMessage` stream into the view state the five
 * Tribunal panels render (seat count, phase, eliminations, reveal — all DERIVED from the
 * stream, nothing hardcoded). The market (pools / state / winning side) is pushed by the
 * server, which reads it from the deployed contract; the connected wallet's own stake and the
 * bet/claim transactions go straight to the contract via `lib/contract.ts`.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { createFeed } from "../lib/feed.js";
import { claimPayout, connectWallet, placeBet as placeBetTx, readMyStakes } from "../lib/contract.js";
import type { Wallet } from "../lib/contract.js";
import type {
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

export type TimelineEvent =
  | { kind: "sealed"; commit: string }
  | { kind: "locked" }
  | { kind: "elimination"; seat: number; round: number; phase: Phase }
  | { kind: "reveal"; winner: Faction }
  | { kind: "settlement"; winningSide: Side };

export interface WalletState {
  account: string | null;
  status: "idle" | "connecting" | "connected" | "error";
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
  seats: PublicSeat[];
  phase: Phase | null;
  round: number;
  winner: Faction | null;
  speakingSeat: number | null;
  currentTurn: PublicTurn | null;
  feed: PublicTurn[];
  attestedCount: number;
  market: MarketSnapshot;
  timeline: TimelineEvent[];
  reveal: { roles: Role[]; winner: Faction } | null;
  transcriptCID: string | null;
  wallet: WalletState;
  stakes: MyStakes;
  tx: TxState;
}

const initialMarket: MarketSnapshot = { state: "OPEN", yesPool: "0", noPool: "0" };

const initialState: ViewState = {
  isMock: false,
  nonce: null,
  personas: [],
  record: null,
  marketAddress: null,
  matchId: null,
  chainId: null,
  seats: [],
  phase: null,
  round: 0,
  winner: null,
  speakingSeat: null,
  currentTurn: null,
  feed: [],
  attestedCount: 0,
  market: initialMarket,
  timeline: [],
  reveal: null,
  transcriptCID: null,
  wallet: { account: null, status: "idle" },
  stakes: { yes: "0", no: "0", claimed: false },
  tx: { pending: false },
};

type Action =
  | { kind: "ws"; msg: WsMessage }
  | { kind: "wallet"; wallet: WalletState }
  | { kind: "stakes"; stakes: MyStakes }
  | { kind: "tx"; tx: TxState };

/** Seats that flipped alive → dead between two public states. */
function newlyDead(prev: readonly PublicSeat[], next: readonly PublicSeat[]): number[] {
  const wasAlive = new Map(prev.map((s) => [s.id, s.alive]));
  return next.filter((s) => !s.alive && wasAlive.get(s.id) === true).map((s) => s.id);
}

function reduce(state: ViewState, action: Action): ViewState {
  if (action.kind === "wallet") return { ...state, wallet: action.wallet };
  if (action.kind === "stakes") return { ...state, stakes: action.stakes };
  if (action.kind === "tx") return { ...state, tx: action.tx };

  const msg = action.msg;
  switch (msg.type) {
    case "match_init":
      return {
        ...initialState,
        // preserve a live wallet connection across a new match
        wallet: state.wallet,
        isMock: msg.isMock,
        nonce: msg.nonce,
        personas: msg.personas,
        record: msg.record,
        marketAddress: msg.marketAddress,
        matchId: msg.matchId,
        chainId: msg.chainId,
        seats: msg.personas.map((p) => ({ id: p.seat, alive: true })),
        timeline: [{ kind: "sealed", commit: msg.record.roleCommit }],
      };

    case "market": {
      const locked = msg.market.state === "LOCKED" && state.market.state !== "LOCKED";
      return {
        ...state,
        market: msg.market,
        timeline: locked ? [...state.timeline, { kind: "locked" }] : state.timeline,
      };
    }

    case "turn": {
      const deaths = newlyDead(state.seats, msg.state.players);
      const elimEvents: TimelineEvent[] = deaths.map((seat) => ({
        kind: "elimination",
        seat,
        round: msg.state.round,
        phase: msg.state.phase,
      }));
      return {
        ...state,
        seats: [...msg.state.players],
        phase: msg.state.phase,
        round: msg.state.round,
        winner: msg.state.winner,
        speakingSeat: msg.turn.seat,
        currentTurn: msg.turn,
        feed: [...state.feed, msg.turn],
        attestedCount: state.attestedCount + 1,
        timeline: [...state.timeline, ...elimEvents],
      };
    }

    case "reveal":
      return {
        ...state,
        winner: msg.winner,
        speakingSeat: null,
        reveal: { roles: msg.roles, winner: msg.winner },
        timeline: [...state.timeline, { kind: "reveal", winner: msg.winner }],
      };

    case "settled":
      return {
        ...state,
        transcriptCID: msg.transcriptCID ?? state.transcriptCID,
        market: { ...state.market, state: "SETTLED", winningSide: msg.winningSide },
        timeline: [...state.timeline, { kind: "settlement", winningSide: msg.winningSide }],
      };

    default:
      return state;
  }
}

export interface MatchApi {
  state: ViewState;
  connect: () => Promise<void>;
  placeBet: (side: Side, amount: string) => Promise<void>;
  claim: () => Promise<void>;
}

export function useMatch(): MatchApi {
  const [state, dispatch] = useReducer(reduce, initialState);

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

  useEffect(() => {
    const feed = createFeed();
    const unsub = feed.subscribe((msg) => {
      dispatch({ kind: "ws", msg });
      // refresh the wallet's own stake when the market opens or settles
      if (msg.type === "match_init" || msg.type === "settled") void refreshStakes();
    });
    feed.start?.();
    return unsub;
  }, [refreshStakes]);

  const connect = useCallback(async () => {
    dispatch({ kind: "wallet", wallet: { account: null, status: "connecting" } });
    try {
      const w = await connectWallet();
      walletRef.current = w;
      dispatch({ kind: "wallet", wallet: { account: w.account, status: "connected" } });
      await refreshStakes();
    } catch (e) {
      dispatch({ kind: "wallet", wallet: { account: null, status: "error", error: (e as Error).message } });
    }
  }, [refreshStakes]);

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
        await refreshStakes();
      } catch (e) {
        dispatch({ kind: "tx", tx: { pending: false, error: (e as Error).message } });
      }
    },
    [connect, refreshStakes],
  );

  const claim = useCallback(async () => {
    if (!walletRef.current || !addrRef.current || matchIdRef.current == null) return;
    dispatch({ kind: "tx", tx: { pending: true } });
    try {
      const hash = await claimPayout(addrRef.current, matchIdRef.current, walletRef.current);
      dispatch({ kind: "tx", tx: { pending: false, lastHash: hash } });
      await refreshStakes();
    } catch (e) {
      dispatch({ kind: "tx", tx: { pending: false, error: (e as Error).message } });
    }
  }, []);

  return { state, connect, placeBet, claim };
}
