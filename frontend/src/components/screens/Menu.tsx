import type { ReactNode } from "react";
import type { MatchApi } from "../../state/matchStore.js";
import type { MatchStatus } from "../../lib/contract.js";
import { useLiveStatus } from "../../lib/useLiveStatus.js";
import { navigate } from "../../lib/useRoute.js";

/**
 * The lobby. The arena, the history, and the wallet were all crammed onto one screen before — this
 * is the calm entry point that routes to each. Connecting a wallet here carries through to the other
 * screens (the match store is mounted once, app-wide).
 *
 * The live WS feed only runs on the Live screen (and opening it would start a match), so the lobby
 * learns "is court in session, what round, how big the pot" from the server's read-only `/status`
 * poll instead — see useLiveStatus. There is no betting-close countdown: betting stays open until
 * settlement by design (server/src/orchestrator.ts), so the chip says "wagers open", not a timer.
 */
export function Menu({ api }: { api: MatchApi }) {
  const s = api.state;
  const connected = s.wallet.status === "connected";
  const balance = s.wallet.balance != null ? parseFloat(s.wallet.balance) : null;
  // Gas relayer status. Session / guest wallets hold no 0G, so they bet ONLY through the relayer —
  // these two flags decide whether pop-up-free wagering is available or paused (offline / out of gas).
  const relayLive = !!s.relay?.enabled;
  const relayFunded = !!s.relay?.funded;
  const status = useLiveStatus();

  return (
    <main className="flex min-h-screen w-full flex-col items-center justify-center px-6 py-[clamp(1.5rem,5vh,3rem)]">
      <div className="w-full max-w-[760px] text-center">
        <div className="eyebrow mb-[clamp(0.5rem,1.5vh,1rem)]">The People v. The Hidden Hand</div>
        <h1 className="font-display text-[clamp(2.5rem,8vw,4rem)] font-semibold uppercase leading-none tracking-[0.4em] text-cream">
          Turing Pits
        </h1>
        <div className="mt-[clamp(0.75rem,2vh,1.25rem)] font-body text-[clamp(1rem,1.8vw,1.1875rem)] italic text-gilt-soft">
          AI agents play Mafia. Every move is TEE-verified and settled on-chain. You wager on the verdict.
        </div>

        <div className="mt-[clamp(1.75rem,5vh,3rem)] grid grid-cols-1 gap-px bg-line sm:grid-cols-2">
          <MenuCard
            kicker="The arena"
            title="Enter the Court"
            blurb="Watch a live match unfold and wager on whether the hidden hand walks free."
            cta="Watch live ›"
            onClick={() => navigate("live")}
            primary
            status={<LiveChip status={status} />}
          />
          <MenuCard
            kicker="The record"
            title="Battle History"
            blurb="Every past battle, its on-chain verdict, and any winnings or refunds left to collect."
            cta="Browse history ›"
            onClick={() => navigate("history")}
          />
        </div>

        <WalletCard
          api={api}
          connected={connected}
          balance={balance}
          relayLive={relayLive}
          relayFunded={relayFunded}
        />

      </div>

      {(s.wallet.error || s.tx.error) && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-6">
          <div className="pointer-events-auto max-w-[440px] rounded-sm border border-convict/50 bg-ink-2/95 px-4 py-2 text-center font-mono text-[11px] text-convict shadow-lg">
            {s.wallet.error ?? s.tx.error}
          </div>
        </div>
      )}
    </main>
  );
}

/**
 * The pull-through cue on the primary card: tells you whether court is in session before you click
 * in. Live → a pulsing dot + round + pot + "wagers open"; idle → a calm note that entering begins
 * the next trial (matches only run while someone is watching).
 */
function LiveChip({ status }: { status: MatchStatus | null }) {
  if (!status || !status.live) {
    return (
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-mute">
        Court is dark — be the first in
      </span>
    );
  }
  const pot = parseFloat(status.pot);
  const potLabel = pot > 0 && pot < 10 ? pot.toFixed(1) : Math.round(pot).toString();
  const round = status.round > 0 ? `round ${status.round}` : "opening";
  const tail = status.bettingLive ? `◈${potLabel} pot · wagers open` : "wagers open soon";
  return (
    <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-gilt">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-convict animate-livepulse" />
      In session · {round} · {tail}
    </span>
  );
}

function MenuCard(p: {
  kicker: string;
  title: string;
  blurb: string;
  cta: string;
  onClick: () => void;
  primary?: boolean;
  status?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={p.onClick}
      className={[
        "panel group flex flex-col items-start px-[clamp(1.25rem,3vw,1.75rem)] py-[clamp(1.5rem,4vh,2rem)] text-left transition-colors hover:bg-ink-3",
        p.primary ? "border-l-2 border-gilt/40" : "",
      ].join(" ")}
    >
      <div className="eyebrow mb-3">{p.kicker}</div>
      <div className="font-display text-[clamp(1.5rem,3.2vw,1.875rem)] tracking-[0.06em] text-cream">{p.title}</div>
      <div className="mt-2 font-body text-[15px] leading-snug text-cream-dim">{p.blurb}</div>
      {p.status && <div className="mt-4">{p.status}</div>}
      <div className="mt-5 font-mono text-[12px] uppercase tracking-[0.16em] text-gilt transition-transform group-hover:translate-x-0.5">
        {p.cta}
      </div>
    </button>
  );
}

/**
 * The wallet, as a card rather than a cramped mono row. Disconnected: one clear CTA + why. Connected:
 * address, balance, the faucet, and — when the server runs a gas relayer — the gasless state spelled
 * out in a sentence so a first-time judge knows what "gasless" buys them, with a plain On/Off toggle.
 */
function WalletCard(p: {
  api: MatchApi;
  connected: boolean;
  balance: number | null;
  relayLive: boolean;
  relayFunded: boolean;
}) {
  const { api, connected, balance, relayLive, relayFunded } = p;
  const s = api.state;

  const connecting = s.wallet.status === "connecting";

  if (!connected) {
    return (
      <div className="panel hairline mx-auto mt-[clamp(1.5rem,4vh,2rem)] w-full max-w-[440px] border px-6 py-[clamp(1.25rem,3vh,1.5rem)] text-center">
        <div className="font-display text-[22px] tracking-[0.04em] text-cream">Connect to wager</div>
        <p className="mx-auto mt-1.5 max-w-[360px] font-body text-[14px] leading-snug text-cream-dim">
          CHIP is free mock test money. Connect once, then place wagers with{" "}
          <span className="text-cream">no pop-up on every bet</span> — the relayer covers gas.
        </p>
        <button
          type="button"
          onClick={() => void api.connect()}
          disabled={connecting}
          className="mt-5 w-full max-w-[300px] rounded-sm border border-gilt px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.16em] text-gilt transition-colors hover:bg-gilt hover:text-ink disabled:opacity-60"
        >
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
        <button
          type="button"
          onClick={() => void api.connectBurner()}
          disabled={connecting}
          className="mt-3 font-mono text-[11px] uppercase tracking-[0.14em] text-mute underline decoration-line-2 underline-offset-4 transition-colors hover:text-gilt disabled:opacity-60"
        >
          No wallet? Play as guest ›
        </button>
      </div>
    );
  }

  const isGuest = s.wallet.mode === "guest";
  // A session / guest wallet always bets through the relayer (it holds no 0G), so there is no gas toggle —
  // just the live relayer state, in plain words. Offline/broke is a hard stop for session wagering.
  const relayExplain = !relayLive
    ? "Gas relayer is offline — session wagering is paused. Try again shortly."
    : !relayFunded
      ? "Relayer is out of 0G — wagering is paused until it's topped up."
      : "Gas-free & pop-up-free — you're signed in, so the relayer covers gas and every wager is instant.";

  return (
    <div className="panel hairline mx-auto mt-[clamp(1.5rem,4vh,2rem)] w-full max-w-[440px] border px-6 py-5 text-left">
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow">{isGuest ? "Guest wallet" : "Session wallet"}</span>
        <span className="font-mono text-[11px] tracking-[0.1em] text-mute">
          {s.wallet.account?.slice(0, 6)}…{s.wallet.account?.slice(-4)} · 0G Galileo
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="font-mono text-[22px] tabular-nums tracking-[0.02em] text-cream">
          ◈ {balance != null ? balance.toFixed(2) : "…"}
          <span className="ml-1.5 text-[12px] tracking-[0.12em] text-mute">CHIP</span>
        </span>
        <button
          type="button"
          onClick={() => void api.getTestTokens()}
          disabled={s.tx.pending}
          className="rounded-sm border border-line-2 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-cream-dim transition-colors hover:border-gilt hover:text-gilt disabled:opacity-60"
        >
          {s.tx.pending ? "Minting…" : "Get test CHIP"}
        </button>
      </div>

      <div className="mt-4 border-t border-line pt-4">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-cream-dim">Gas-free betting</span>
          <span
            className={[
              "rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em]",
              relayLive && relayFunded ? "border-gilt/60 text-gilt" : "border-convict/50 text-convict",
            ].join(" ")}
          >
            {relayLive && relayFunded ? "On" : "Paused"}
          </span>
        </div>
        <p className="mt-1.5 font-body text-[13px] leading-snug text-mute">{relayExplain}</p>
        {isGuest && (
          <p className="mt-1.5 font-body text-[12px] leading-snug text-mute/80">
            Guest keys live in this browser — mock CHIP only. Connect a wallet to carry your identity across devices.
          </p>
        )}
      </div>
    </div>
  );
}
