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
 * Every market — the headline faction market and the side markets alike — is a categorical prop.
 * Its pools / state are pushed by the server (read from the deployed contract) and rendered
 * truthfully/immediately — it is money, not narrative. The connected wallet's own per-outcome stake,
 * balance, and the betProp/claimProp/refundProp transactions go straight to the contract via
 * `lib/contract.ts`.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createFeed } from "../lib/feed.js";
import {
  batchClaimPayout,
  batchRefundStake,
  claimPropPayout,
  connectBurnerWallet,
  connectSessionWallet,
  enterRefundMode,
  getBalance,
  getTestTokens as getTestTokensTx,
  humanizeTxError,
  MARKET_ADDRESS,
  placePropBet as placePropBetTx,
  readMarketState,
  readMyPropStakes,
  readProps,
  readPropPositions,
  refundPropStake,
  relayInfo,
  restoreBurnerWallet,
  setDisplayName as setDisplayNameTx,
} from "../lib/contract.js";
import type { MyPropStake, Wallet } from "../lib/contract.js";
import { setLocalName } from "../lib/names.js";
import { propReclaimsOf } from "../lib/reclaims.js";
import { coins } from "../lib/typeSound.js";
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
  WsMessage,
} from "../lib/types.js";

/** One unit of playback. `seats` is the alive/dead snapshot to render while this beat is on stage. */
export type Beat =
  | { kind: "night"; round: number; seats: PublicSeat[] }
  | { kind: "dawn"; round: number; killed: number[]; saved: number; seats: PublicSeat[] }
  | { kind: "discussion"; seat: number; round: number; speech: string; seats: PublicSeat[] }
  // A seat going public as the Detective (a real reveal or a Mafia fake-claim), promoted from a
  // discussion turn to its own scene. `counter` marks a rival claim (a public fork). Leaks no role.
  | { kind: "claim"; seat: number; round: number; counter: boolean; speech: string; seats: PublicSeat[] }
  // A synchronized betting window: the match pauses and one side market is spotlighted with a countdown.
  | { kind: "bet_window"; market: BetWindowMarket; round: number; propIndex: number; endsAt: number; seat?: number; seats: PublicSeat[] }
  | { kind: "turn"; turn: PublicTurn; round: number; phase: Phase; seats: PublicSeat[] };

export type BetWindowMarket = "NIGHT_KILL" | "ROUND_VOTED_OUT" | "DETECTIVE_CLAIM";
/** The active in-loop betting window, derived from the beat under the cursor (null when none is on stage). */
export interface BetWindow {
  market: BetWindowMarket;
  round: number;
  propIndex: number;
  endsAt: number;
  seat?: number;
}

export interface WalletState {
  account: string | null;
  status: "idle" | "connecting" | "connected" | "error";
  /** CHIP (bet token) balance as a decimal string; undefined until first read. */
  balance?: string;
  /**
   * How the connected identity was obtained — drives the wallet badge + copy. "session" = an in-browser
   * key derived from one signature by the user's wallet; "guest" = a pure browser burner (no wallet).
   * Both are session keys that bet pop-up-free via the relayer; undefined until connected.
   */
  mode?: "session" | "guest";
  error?: string;
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
  /** The on-chain settlement tx hash (from the settled message) — links THE RECORD to the explorer. */
  settleTxHash: string | null;
  wallet: WalletState;
  /**
   * Optional gas-relayer state (the "gasless" path). `null` until checked / when no relayer is
   * configured. `enabled` = the server runs a relayer; `funded` = its wallet still has 0G to sponsor
   * txs. When a relayer is live and funded, wallet actions default to gasless (the user signs, the
   * relayer pays) unless the user opts out — see `gaslessPref` / the derived `gasless` in the API.
   */
  relay: { enabled: boolean; funded: boolean } | null;
  /** User preference: "auto" = gasless whenever the relayer can sponsor; "off" = always pay own gas. */
  gaslessPref: "auto" | "off";
  /** The connected wallet's own stake + claimed flag on EACH market (faction + side markets), by propIdx. */
  propStakes: MyPropStake[];
  tx: TxState;

  // ── raw ingest (every beat received, in order) ──
  beats: Beat[];
  rawReveal: { roles: Role[]; winner: Faction } | null;

  // ── playback ──
  /** Index of the beat currently on the stage; -1 before the first beat is shown. */
  cursor: number;
  /** True once the final beat has finished typing — gates the reveal/sentence scenes. */
  playbackComplete: boolean;
  /**
   * High-water mark of the playback cursor (monotonic — stepping back never lowers it). The round
   * markets are opened on-chain AHEAD of the paced stream (round 1's at match creation, later rounds a
   * beat early), so `reachedNight`/`reachedDay`/`reachedClaim` — derived from the beats up to here — gate
   * WHICH of those markets the Wagers list shows, so a "Night 2 kill" row never floats before the stream
   * has reached night 2. Cursor-relative (not the on-chain props) so it matches what the viewer is watching.
   */
  maxCursor: number;
  /** Highest round whose NIGHT the playback has reached (a `night` beat / NIGHT_KILL window shown). */
  reachedNight: number;
  /** Highest round whose DAY the playback has reached (dawn/discussion/claim/vote / VOTED_OUT window). */
  reachedDay: number;
  /** True once a Detective claim beat (or its window) has been shown — floats the "real or bluff?" market. */
  reachedClaim: boolean;
  /**
   * How many received beats are buffered AHEAD of the cursor (i.e. how far the stage trails the
   * latest thing the server has sent). The stage holds each beat several seconds while the server
   * emits them roughly once a second, so a viewer steadily falls behind "live" during a match and a
   * late joiner starts at 0. When this is large the stage is effectively replaying; "Skip to
   * present" jumps the cursor to the newest beat. See `CATCHUP_THRESHOLD`.
   */
  pendingBeats: number;

  // ── DERIVED from the cursor (what the panels render) ──
  seats: PublicSeat[];
  phase: Phase | null;
  round: number;
  winner: Faction | null;
  speakingSeat: number | null;
  currentBeat: Beat | null;
  currentTurn: PublicTurn | null;
  /** The betting window on stage right now (a `bet_window` beat under the cursor), else null. Drives
   *  the Verdict spotlight + the on-stage countdown. Cleared once playback moves off the beat / completes. */
  betWindow: BetWindow | null;
  attestedCount: number;
  reveal: { roles: Role[]; winner: Faction } | null;
  /** Live day-vote tally for the active round: seat id → votes received so far (up to the cursor). */
  votes: Record<number, number>;

  // ── connection / liveness ──
  connection: ConnStatus;
}

/**
 * How far the stage must trail the latest received beat before we treat it as a replay and surface
 * the "Skip to present" affordance. A small lag is normal (the stage paces each beat), so we only
 * call it out once a handful of beats have queued up behind the cursor.
 */
export const CATCHUP_THRESHOLD = 3;

const initialMarket: MarketSnapshot = { state: "OPEN", bettingLive: false };

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
  settleTxHash: null,
  wallet: { account: null, status: "idle" },
  relay: null,
  gaslessPref: "auto",
  propStakes: [],
  tx: { pending: false },
  beats: [],
  rawReveal: null,
  cursor: -1,
  playbackComplete: false,
  maxCursor: -1,
  reachedNight: 0,
  reachedDay: 0,
  reachedClaim: false,
  pendingBeats: 0,
  seats: [],
  phase: null,
  round: 0,
  winner: null,
  speakingSeat: null,
  currentBeat: null,
  currentTurn: null,
  betWindow: null,
  attestedCount: 0,
  reveal: null,
  votes: {},
  connection: "connecting",
};

type Action =
  | { kind: "ws"; msg: WsMessage }
  | { kind: "advance" }
  | { kind: "stepBack" }
  | { kind: "skip" }
  | { kind: "reset" }
  | { kind: "connection"; status: ConnStatus }
  | { kind: "wallet"; wallet: WalletState }
  | { kind: "propStakes"; propStakes: MyPropStake[] }
  | { kind: "relay"; relay: { enabled: boolean; funded: boolean } | null }
  | { kind: "gaslessPref"; pref: "auto" | "off" }
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
  // The seat on the floor — a day vote, an unsigned deliberation contribution, or a Detective claim.
  const speaker =
    beat?.kind === "turn" ? beat.turn.seat
    : beat?.kind === "discussion" || beat?.kind === "claim" ? beat.seat
    : null;
  const phase: Phase | null = beat
    ? beat.kind === "night"
      ? "night"
      : beat.kind === "dawn" || beat.kind === "discussion" || beat.kind === "claim"
        ? "day"
        : beat.kind === "bet_window"
          ? beat.market === "NIGHT_KILL" ? "night" : "day" // the night-kill window IS the night; the rest are day
          : beat.phase
    : null;
  // The window on stage right now — cleared once playback moves off it or the record closes.
  const betWindow =
    beat?.kind === "bet_window" && !s.playbackComplete
      ? { market: beat.market, round: beat.round, propIndex: beat.propIndex, endsAt: beat.endsAt, seat: beat.seat }
      : null;
  const reveal = s.playbackComplete ? s.rawReveal : null;

  // Monotonic playback high-water mark + the furthest night/day/claim the stream has reached by it. Used
  // to gate which recurring markets the Wagers list shows (they open on-chain ahead of the paced stream).
  // Cursor-relative so it tracks the viewer's position, but never rolls back when they step back to re-read.
  const maxCursor = Math.max(s.maxCursor, c);
  let reachedNight = 0;
  let reachedDay = 0;
  let reachedClaim = false;
  for (let i = 0; i <= maxCursor; i++) {
    const b = s.beats[i];
    if (!b) continue;
    if (b.kind === "night") reachedNight = Math.max(reachedNight, b.round);
    else if (b.kind === "dawn" || b.kind === "discussion" || b.kind === "turn") reachedDay = Math.max(reachedDay, b.round);
    else if (b.kind === "claim") {
      reachedDay = Math.max(reachedDay, b.round);
      reachedClaim = true;
    } else if (b.kind === "bet_window") {
      if (b.market === "NIGHT_KILL") reachedNight = Math.max(reachedNight, b.round);
      else if (b.market === "ROUND_VOTED_OUT") reachedDay = Math.max(reachedDay, b.round);
      else reachedClaim = true; // DETECTIVE_CLAIM window
    }
  }

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
    betWindow,
    attestedCount: attested,
    reveal,
    votes,
    maxCursor,
    reachedNight,
    reachedDay,
    reachedClaim,
    pendingBeats: Math.max(0, s.beats.length - 1 - c),
  };
}

function reduce(state: ViewState, action: Action): ViewState {
  if (action.kind === "wallet") return { ...state, wallet: action.wallet };
  if (action.kind === "propStakes") return { ...state, propStakes: action.propStakes };
  if (action.kind === "relay") return { ...state, relay: action.relay };
  if (action.kind === "gaslessPref") return { ...state, gaslessPref: action.pref };
  if (action.kind === "tx") return { ...state, tx: action.tx };
  if (action.kind === "connection") return { ...state, connection: action.status };

  // Leaving and re-entering the live screen tears down the feed; reset to a clean slate (keeping the
  // wallet connection + relay/gasless preference) so a returning viewer doesn't see the previous match.
  if (action.kind === "reset") return project({ ...baseState, wallet: state.wallet, relay: state.relay, gaslessPref: state.gaslessPref });

  if (action.kind === "advance") {
    if (state.cursor < state.beats.length - 1) return project({ ...state, cursor: state.cursor + 1 });
    if (!state.playbackComplete && state.rawReveal) return project({ ...state, playbackComplete: true });
    return state;
  }

  // Step the cursor BACK one beat so a viewer can re-read a moment they missed. If the post-playback
  // reveal is showing, the first step drops it (re-showing the final beat) before the cursor retreats.
  // No-op at the very first beat.
  if (action.kind === "stepBack") {
    if (state.playbackComplete) return project({ ...state, playbackComplete: false });
    if (state.cursor > 0) return project({ ...state, cursor: state.cursor - 1 });
    return state;
  }

  // Jump straight to the newest beat the server has sent (skip the replay/catch-up). If the match
  // has already ended (the reveal is in hand), also flip playbackComplete so the verdict shows at
  // once instead of forcing one more step. No-op before the first beat lands.
  if (action.kind === "skip") {
    const last = state.beats.length - 1;
    if (last < 0) return state;
    return project({ ...state, cursor: last, playbackComplete: state.rawReveal != null ? true : state.playbackComplete });
  }

  const msg = action.msg;
  switch (msg.type) {
    case "match_init":
      return project({
        ...baseState,
        // preserve a live wallet connection + gasless preference across a new match
        wallet: state.wallet,
        relay: state.relay,
        gaslessPref: state.gaslessPref,
        // match_init arrives over an already-OPEN socket — keep the live status (baseState would
        // otherwise slam it back to "connecting", leaving the masthead stuck on "Connecting…").
        connection: state.connection,
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
      // `saved ?? 0` tolerates an older/replayed dawn message that predates the shielded-lives count.
      return pushBeat(state, { kind: "dawn", round: msg.round, killed: msg.killed, saved: msg.saved ?? 0, seats: [...msg.state.players] });

    case "discussion":
      return pushBeat(state, {
        kind: "discussion",
        seat: msg.seat,
        round: msg.round,
        speech: msg.speech,
        seats: [...msg.state.players],
      });

    case "claim":
      // A Detective reveal / Mafia fake-claim, promoted to its own scene. Role-free: whether the claim
      // is TRUE settles only from the end-of-match reveal (the "real or bluff?" market).
      return pushBeat(state, {
        kind: "claim",
        seat: msg.seat,
        round: msg.round,
        counter: msg.counter,
        speech: msg.speech,
        seats: [...msg.state.players],
      });

    case "bet_window":
      // A synchronized betting window — a stage beat that pauses playback and spotlights one market.
      return pushBeat(state, {
        kind: "bet_window",
        market: msg.market,
        round: msg.round,
        propIndex: msg.propIndex,
        endsAt: msg.endsAt,
        seat: msg.seat,
        seats: carrySeats(state),
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
      // The faction verdict + every market's payout ride in the final `market` snapshot's props; the
      // settled message only carries the settle tx receipt + transcript pointer.
      return project({
        ...state,
        transcriptCID: msg.transcriptCID ?? state.transcriptCID,
        settleTxHash: msg.txHash ?? state.settleTxHash,
        market: { ...state.market, state: "SETTLED" },
      });

    default:
      return state;
  }
}

/**
 * The connected wallet's collectable pots on a just-finished battle. Snapshotted at settlement and kept
 * ALIVE across the next round's match_init (which resets the reducer + Verdict), so the spectator never
 * loses the chance to collect just because playback lagged or a new round began. One-tap batch collect.
 */
export interface Winnings {
  matchId: number;
  /** true → the match was abandoned; collect via batchRefund. false → settled; collect via batchClaim. */
  refund: boolean;
  /** The prop indices to hand the batch call (every market with an outstanding pot). */
  idxs: number[];
  /** Total CHIP across every collectable market, formatted (e.g. "3.9200"). */
  total: string;
  /** How many markets are in the batch — powers "across N markets". */
  count: number;
}

export interface MatchApi {
  state: ViewState;
  /** True when wallet actions currently route through the gas relayer (user signs, relayer pays gas). */
  gasless: boolean;
  /** Connect a session key derived from ONE signature by the user's injected wallet — then bet pop-up-free. */
  connect: () => Promise<void>;
  /** Connect a pure in-browser guest burner (no wallet, no signature) — also bets pop-up-free via the relayer. */
  connectBurner: () => Promise<void>;
  /** Wager on ANY market (faction + side) by staking on one `outcome`, identified by propIdx. */
  placePropBet: (propIdx: number, outcome: number, amount: string) => Promise<void>;
  /** Claim a SETTLED market payout/return. Defaults to the live match; pass a matchId for a prior round. */
  claimProp: (propIdx: number, matchId?: number) => Promise<void>;
  /** Reclaim a market stake from a RefundMode match. Defaults to the live match; pass a matchId for a prior round. */
  refundProp: (propIdx: number, matchId?: number) => Promise<void>;
  /** Collect EVERY listed market on a past battle in one batch tx (batchClaim, or batchRefund when `refund`). */
  claimAllProps: (matchId: number, idxs: number[], refund: boolean) => Promise<boolean>;
  /** Mint free test CHIP to the connected wallet (the demo faucet), then refresh the balance. */
  getTestTokens: () => Promise<void>;
  /** Claim a custom display handle for the connected wallet (signed locally, shared via the server). */
  setDisplayName: (name: string) => Promise<void>;
  /** Flip an abandoned, past-deadline match into RefundMode so its stake becomes refundable. */
  enterRefund: (matchId: number) => Promise<void>;
  /** Opt the gasless path on/off ("off" = always pay your own gas). No-op when no relayer is live. */
  setGasless: (on: boolean) => void;
  /** Collectable winnings on the last finished battle, kept alive across the next round; null when none/collected. */
  winnings: Winnings | null;
  /** Collect every market in `winnings` in ONE batch tx, then clear the tray. */
  claimAllWinnings: () => Promise<void>;
  /** Dismiss the winnings tray without collecting (the pots stay reclaimable later from History). */
  dismissWinnings: () => void;
  /** Advance the playback cursor to the next beat (called by the Court once a beat finishes). */
  advance: () => void;
  /** Step the playback cursor back one beat — re-read a moment (pairs with the stage pause control). */
  stepBack: () => void;
  /** Jump the playback cursor to the newest received beat — skips the replay/catch-up to "now". */
  skipToPresent: () => void;
}

export function useMatch({ live }: { live: boolean }): MatchApi {
  const [state, dispatch] = useReducer(reduce, baseState);

  // Non-render refs the async wallet actions need without re-subscribing the feed.
  const walletRef = useRef<Wallet | null>(null);
  // How the connected identity was obtained ("session"/"guest"). Kept in a ref so the balance refresh
  // (which re-dispatches the whole WalletState) preserves the badge instead of wiping it. Wallet.kind
  // can't stand in — it's "session" for BOTH derived and guest keys; this is the finer distinction.
  const modeRef = useRef<"session" | "guest" | undefined>(undefined);
  const addrRef = useRef<string | null>(null);
  // Fall back to the known deployed market so wallet actions (e.g. reclaiming a past battle from the
  // History screen) work even before the live screen has reported the address via match_init.
  addrRef.current = state.marketAddress ?? MARKET_ADDRESS;
  const matchIdRef = useRef<number | null>(null);
  matchIdRef.current = state.matchId;
  // Number of side markets. It GROWS during the match as each round's "voted out" + "night kill" markets
  // open, so prefer the pushed props length (the live count). Fall back to the persona roster + 2 — the
  // at-creation count (one PlayerFate per seat + the round-1 RoundVotedOut + round-1 NightKill markets) —
  // so prop-stake reads cover the upfront markets before the first market push lands.
  const propCountRef = useRef(0);
  propCountRef.current = state.market.props?.length ?? state.personas.length + 2;

  // Gasless is the DEFAULT whenever the server's relayer is live AND still funded — the user signs
  // and the relayer pays. We never gate this on the USER's own 0G balance (a fresh wallet with zero
  // 0G is exactly who this is for); we fall back to the direct path only when the relayer is
  // absent/broke, or when the user has explicitly opted out (gaslessPref === "off"). The write
  // callbacks read `gaslessRef` so they don't need to re-subscribe when it flips.
  const gasless = !!(state.relay?.enabled && state.relay?.funded && state.gaslessPref !== "off");
  const gaslessRef = useRef(gasless);
  gaslessRef.current = gasless;

  const refreshPropStakes = useCallback(async () => {
    if (!walletRef.current || !addrRef.current || matchIdRef.current == null || propCountRef.current === 0) return;
    try {
      const propStakes = await readMyPropStakes(addrRef.current, matchIdRef.current, propCountRef.current, walletRef.current);
      dispatch({ kind: "propStakes", propStakes });
    } catch {
      /* read failures are non-fatal; pools still come over WS */
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!walletRef.current) return;
    try {
      const balance = await getBalance(walletRef.current, addrRef.current ?? undefined);
      dispatch({ kind: "wallet", wallet: { account: walletRef.current.account, status: "connected", balance, mode: modeRef.current } });
    } catch {
      /* balance is display-only; ignore read failures */
    }
  }, []);

  // Re-poll the relayer's status (enabled + still funded). `force` re-fetches /relay/info (used after
  // each wager so `funded` flips off promptly once the relayer drains); the initial mount check is cached.
  const refreshRelay = useCallback(async (force = false) => {
    try {
      const info = await relayInfo(force);
      dispatch({ kind: "relay", relay: info ? { enabled: info.enabled, funded: info.funded } : null });
    } catch {
      /* the relayer is optional; a failed probe just leaves the direct path */
    }
  }, []);

  // The live WebSocket is connected ONLY while the live screen is mounted (`live` true). This is
  // what makes a match launch only when someone is on the live screen: the server waits for the
  // first client before starting a round. Leaving the screen closes the socket; returning opens a
  // fresh one (the feed instance is single-use once closed) and replays the current match buffer.
  useEffect(() => {
    if (!live) return;
    dispatch({ kind: "reset" });
    const feed = createFeed();
    const unsub = feed.subscribe((msg) => {
      dispatch({ kind: "ws", msg });
      // Refresh the wallet's own per-market stake when the match SETTLES (same matchId — refs are current).
      // NOT on match_init: that changes the matchId, but matchIdRef/propCountRef only update on the next
      // render, so a sync read here would fetch the PREVIOUS match's stakes and clobber the fresh reset
      // (the book would "carry over" until you next bet). The matchId-keyed effect below refreshes instead,
      // after the render lands the new ids.
      if (msg.type === "settled") {
        void refreshPropStakes();
      }
    });
    const unsubStatus = feed.onStatus?.((status) => dispatch({ kind: "connection", status }));
    feed.start?.();
    return () => {
      unsub();
      unsubStatus?.();
    };
  }, [live, refreshPropStakes]);

  // Refresh the wallet's own per-market book whenever the MATCH changes (a new round's match_init resets
  // the reducer's propStakes to [], then this fires — after the render has landed the new matchId in the
  // refs — so the book reflects the NEW match, not the one that just ended. Doing this sync in the WS
  // handler would read stale refs and carry the previous match's positions over.
  useEffect(() => {
    if (state.matchId != null) void refreshPropStakes();
  }, [state.matchId, refreshPropStakes]);

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
        if (stop || (m.state !== "SETTLED" && m.state !== "REFUND")) return;
        // Terminal on-chain: pull the props (which carry every market's verdict + pools, the faction
        // headline included) and push them as the market snapshot so the Verdict panel can resolve.
        const props = await readProps(address, matchId).catch(() => undefined);
        if (stop) return;
        dispatch({ kind: "ws", msg: { type: "market", market: { state: m.state, props } } });
        if (m.state === "SETTLED") dispatch({ kind: "ws", msg: { type: "settled" } });
        void refreshPropStakes();
      } catch {
        /* transient RPC failure; try again next tick */
      }
    };
    const id = setInterval(tick, 15000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [state.market.state, state.marketAddress, state.matchId, refreshPropStakes]);

  // Probe the relayer once on mount so the gasless affordance reflects reality before the user connects.
  useEffect(() => {
    void refreshRelay();
  }, [refreshRelay]);

  // Connect the DERIVED session key: the user signs one message with their injected wallet, and every
  // wager after that is signed locally (no pop-up) and gas-sponsored by the relayer. See connectSessionWallet.
  const connect = useCallback(async () => {
    dispatch({ kind: "wallet", wallet: { account: null, status: "connecting" } });
    try {
      const w = await connectSessionWallet();
      walletRef.current = w;
      modeRef.current = "session";
      dispatch({ kind: "wallet", wallet: { account: w.account, status: "connected", mode: "session" } });
      await Promise.all([refreshPropStakes(), refreshBalance(), refreshRelay(true)]);
    } catch (e) {
      dispatch({ kind: "wallet", wallet: { account: null, status: "error", error: humanizeTxError(e) } });
    }
  }, [refreshPropStakes, refreshBalance, refreshRelay]);

  // Connect a pure GUEST burner: no injected wallet, no signature — an in-browser key that bets
  // pop-up-free via the relayer. For visitors with no wallet, or who'd rather not sign. Persisted so a
  // reload keeps the same guest identity (and its CHIP / positions).
  const connectBurner = useCallback(async () => {
    dispatch({ kind: "wallet", wallet: { account: null, status: "connecting" } });
    try {
      const w = connectBurnerWallet();
      walletRef.current = w;
      modeRef.current = "guest";
      dispatch({ kind: "wallet", wallet: { account: w.account, status: "connected", mode: "guest" } });
      await Promise.all([refreshPropStakes(), refreshBalance(), refreshRelay(true)]);
    } catch (e) {
      dispatch({ kind: "wallet", wallet: { account: null, status: "error", error: humanizeTxError(e) } });
    }
  }, [refreshPropStakes, refreshBalance, refreshRelay]);

  // Returning guest: silently restore a previously-created burner on mount so its CHIP / open positions
  // aren't stranded. No wallet interaction, no pop-up. A later connect() (deriving from a real wallet)
  // simply overrides it. Runs once; a live connection already in `walletRef` short-circuits it.
  useEffect(() => {
    if (walletRef.current) return;
    const w = restoreBurnerWallet();
    if (!w) return;
    walletRef.current = w;
    modeRef.current = "guest";
    dispatch({ kind: "wallet", wallet: { account: w.account, status: "connected", mode: "guest" } });
    void Promise.all([refreshPropStakes(), refreshBalance(), refreshRelay(true)]);
  }, [refreshPropStakes, refreshBalance, refreshRelay]);

  // Wager on ANY market (the faction headline + the side markets) by staking on one `outcome`; propIdx identifies the market.
  const placePropBet = useCallback(
    async (propIdx: number, outcome: number, amount: string) => {
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
      // No optimistic overlay — the odds move only when the authoritative pool push + stake refresh land,
      // so the book updates the same instant every spectator sees it (a click no longer jumps the pot).
      dispatch({ kind: "tx", tx: { pending: true } });
      try {
        const hash = await placePropBetTx(address, matchId, propIdx, walletRef.current, outcome, amount, gaslessRef.current);
        dispatch({ kind: "tx", tx: { pending: false, lastHash: hash } });
        coins(); // wager landed on-chain — the coin-bag jingle
        await Promise.all([refreshPropStakes(), refreshBalance(), refreshRelay(true)]);
      } catch (e) {
        dispatch({ kind: "tx", tx: { pending: false, error: humanizeTxError(e) } });
      }
    },
    [connect, refreshPropStakes, refreshBalance, refreshRelay],
  );

  // Claim a SETTLED survival side-market payout (Yes/No) or returned stake (Void). Defaults to the
  // live match; pass a matchId for a prior round (History). Use refundProp for RefundMode matches.
  const claimProp = useCallback(
    async (propIdx: number, matchId?: number) => {
      const id = matchId ?? matchIdRef.current;
      if (!walletRef.current || !addrRef.current || id == null) return;
      dispatch({ kind: "tx", tx: { pending: true } });
      try {
        const hash = await claimPropPayout(addrRef.current, id, propIdx, walletRef.current, gaslessRef.current);
        dispatch({ kind: "tx", tx: { pending: false, lastHash: hash } });
        coins(); // winnings reclaimed — the coin-bag jingle
        await Promise.all([refreshPropStakes(), refreshBalance(), refreshRelay(true)]);
      } catch (e) {
        dispatch({ kind: "tx", tx: { pending: false, error: humanizeTxError(e) } });
      }
    },
    [refreshPropStakes, refreshBalance, refreshRelay],
  );

  // Reclaim a survival side-market stake from a match in RefundMode (host never settled). Defaults to
  // the live match; pass a matchId for a prior round (History).
  const refundProp = useCallback(
    async (propIdx: number, matchId?: number) => {
      const id = matchId ?? matchIdRef.current;
      if (!walletRef.current || !addrRef.current || id == null) return;
      dispatch({ kind: "tx", tx: { pending: true } });
      try {
        const hash = await refundPropStake(addrRef.current, id, propIdx, walletRef.current, gaslessRef.current);
        dispatch({ kind: "tx", tx: { pending: false, lastHash: hash } });
        coins(); // stake reclaimed — the coin-bag jingle
        await Promise.all([refreshPropStakes(), refreshBalance(), refreshRelay(true)]);
      } catch (e) {
        dispatch({ kind: "tx", tx: { pending: false, error: humanizeTxError(e) } });
      }
    },
    [refreshPropStakes, refreshBalance, refreshRelay],
  );

  const getTestTokens = useCallback(async () => {
    if (!walletRef.current) {
      await connect();
      if (!walletRef.current) return;
    }
    dispatch({ kind: "tx", tx: { pending: true } });
    try {
      const hash = await getTestTokensTx(walletRef.current, addrRef.current ?? undefined, gaslessRef.current);
      dispatch({ kind: "tx", tx: { pending: false, lastHash: hash } });
      await Promise.all([refreshBalance(), refreshRelay(true)]);
    } catch (e) {
      dispatch({ kind: "tx", tx: { pending: false, error: humanizeTxError(e) } });
    }
  }, [connect, refreshBalance, refreshRelay]);

  // enterRefund accepts an explicit matchId so the prior-positions panel can flip a past abandoned
  // match; after it confirms, the bettor reclaims each market via refundProp.
  const enterRefund = useCallback(async (matchId: number) => {
    if (!walletRef.current || !addrRef.current) return;
    dispatch({ kind: "tx", tx: { pending: true } });
    try {
      const hash = await enterRefundMode(addrRef.current, matchId, walletRef.current, gaslessRef.current);
      dispatch({ kind: "tx", tx: { pending: false, lastHash: hash } });
      await Promise.all([refreshPropStakes(), refreshBalance(), refreshRelay(true)]);
    } catch (e) {
      dispatch({ kind: "tx", tx: { pending: false, error: humanizeTxError(e) } });
    }
  }, [refreshPropStakes, refreshBalance, refreshRelay]);

  // ── Persistent winnings tray ─────────────────────────────────────────────────────────────────────
  // Lives in its OWN state, not the reducer, so the next round's match_init (a full reducer reset that
  // wipes the Verdict) can't erase it. When a match the wallet backed reaches a terminal state we snapshot
  // its collectable pots here — once per matchId — and keep them until the spectator collects or dismisses.
  const [winnings, setWinnings] = useState<Winnings | null>(null);
  const capturedMatchRef = useRef<number | null>(null);

  const account = state.wallet.account;
  const marketState = state.market.state;
  const settledMatchId = state.matchId;
  // Only reveal a SETTLED win once the spectator has actually watched to the verdict (playbackComplete) —
  // capturing on the raw on-chain SETTLED would flash "you won ◈X" on stage while the match is still
  // playing out, spoiling the reveal. An abandoned (REFUND) match has no verdict to spoil and the Court
  // shows the dissolution immediately, so it can capture right away.
  const playbackComplete = state.playbackComplete;
  useEffect(() => {
    if (!account || settledMatchId == null) return;
    const terminalReady = marketState === "REFUND" || (marketState === "SETTLED" && playbackComplete);
    if (!terminalReady) return;
    if (capturedMatchRef.current === settledMatchId) return; // already snapshotted this battle
    const addr = addrRef.current;
    if (!addr) return;
    capturedMatchRef.current = settledMatchId;
    let cancelled = false;
    (async () => {
      // One position fan-out (retried a couple of times so a transient RPC blip doesn't cost the tray).
      let positions: Awaited<ReturnType<typeof readPropPositions>> | null = null;
      for (let t = 0; t < 3 && !cancelled; t++) {
        try {
          positions = await readPropPositions(addr, settledMatchId, account);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (cancelled || !positions) {
        if (!cancelled) capturedMatchRef.current = null; // let a later state change retry
        return;
      }
      const reclaims = propReclaimsOf(positions, marketState === "REFUND" ? "REFUND" : "SETTLED");
      if (reclaims.length === 0) return; // nothing won here — leave any existing tray from a prior battle
      const total = reclaims.reduce((a, r) => a + parseFloat(r.amount), 0);
      setWinnings({
        matchId: settledMatchId,
        refund: marketState === "REFUND",
        idxs: reclaims.map((r) => r.index),
        total: total.toFixed(4),
        count: reclaims.length,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [account, marketState, settledMatchId, playbackComplete]);

  // Collect every listed market on one battle in a single batch tx (batchClaim, or batchRefund for an
  // abandoned match). The contract skips anything already-claimed/losing, so passing the whole set is
  // safe. Shared by the live winnings tray and the History rows; returns whether the tx confirmed.
  const claimAllProps = useCallback(
    async (matchId: number, idxs: number[], refund: boolean): Promise<boolean> => {
      if (!walletRef.current || !addrRef.current || idxs.length === 0) return false;
      dispatch({ kind: "tx", tx: { pending: true } });
      try {
        const hash = refund
          ? await batchRefundStake(addrRef.current, matchId, idxs, walletRef.current, gaslessRef.current)
          : await batchClaimPayout(addrRef.current, matchId, idxs, walletRef.current, gaslessRef.current);
        dispatch({ kind: "tx", tx: { pending: false, lastHash: hash } });
        coins(); // batch collect landed — the coin-bag jingle
        await Promise.all([refreshPropStakes(), refreshBalance(), refreshRelay(true)]);
        return true;
      } catch (e) {
        dispatch({ kind: "tx", tx: { pending: false, error: humanizeTxError(e) } });
        return false;
      }
    },
    [refreshPropStakes, refreshBalance, refreshRelay],
  );

  // The tray's one-tap collect: sweep its snapshot in one batch, then clear it on success.
  const claimAllWinnings = useCallback(async () => {
    const w = winnings;
    if (!w) return;
    if (await claimAllProps(w.matchId, w.idxs, w.refund)) setWinnings(null);
  }, [winnings, claimAllProps]);

  const dismissWinnings = useCallback(() => setWinnings(null), []);

  // Claim a display handle for the leaderboard. The wallet's session key signs the name message locally
  // (no pop-up); the server verifies + shares it. Also cache it locally so the lobby reflects it at once.
  // Not a chain tx, so it stays out of the tx/toaster state — the caller (the lobby) shows its own status.
  const setDisplayName = useCallback(async (name: string) => {
    const w = walletRef.current;
    if (!w) throw new Error("Connect a wallet to set a handle.");
    await setDisplayNameTx(w, name);
    setLocalName(w.account, name);
  }, []);

  const advance = useCallback(() => dispatch({ kind: "advance" }), []);
  const stepBack = useCallback(() => dispatch({ kind: "stepBack" }), []);
  const skipToPresent = useCallback(() => dispatch({ kind: "skip" }), []);

  // Let the user opt out of (or back into) the gasless path. "off" forces their own wallet to pay gas.
  const setGasless = useCallback((on: boolean) => dispatch({ kind: "gaslessPref", pref: on ? "auto" : "off" }), []);

  return { state, gasless, connect, connectBurner, placePropBet, claimProp, refundProp, claimAllProps, getTestTokens, setDisplayName, enterRefund, setGasless, winnings, claimAllWinnings, dismissWinnings, advance, stepBack, skipToPresent };
}
