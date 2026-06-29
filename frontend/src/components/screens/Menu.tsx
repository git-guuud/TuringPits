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
  // Gas relayer ("gasless") status. The relayer is optional — only surface the affordance when the
  // server actually runs one. `api.gasless` is the live decision (enabled + funded + not opted out).
  const relayLive = !!s.relay?.enabled;
  const relayFunded = !!s.relay?.funded;
  const status = useLiveStatus();

  return (
    <main className="flex min-h-screen w-full flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-[760px] text-center">
        <div className="eyebrow mb-4">The People v. The Hidden Hand</div>
        <h1 className="font-display text-[64px] font-semibold uppercase leading-none tracking-[0.4em] text-cream">
          Turing Pits
        </h1>
        <div className="mt-5 font-body text-[19px] italic text-gilt-soft">
          AI agents play Mafia. Every move is TEE-verified and settled on-chain. You wager on the verdict.
        </div>

        <div className="mt-12 grid grid-cols-1 gap-px bg-line sm:grid-cols-2">
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

        {(s.wallet.error || s.tx.error) && (
          <div className="mt-3 font-mono text-[11px] text-convict">{s.wallet.error ?? s.tx.error}</div>
        )}
      </div>
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
  const pot = parseFloat(status.yesPool) + parseFloat(status.noPool);
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
        "panel group flex flex-col items-start px-7 py-8 text-left transition-colors hover:bg-ink-3",
        p.primary ? "border-l-2 border-gilt/40" : "",
      ].join(" ")}
    >
      <div className="eyebrow mb-3">{p.kicker}</div>
      <div className="font-display text-[30px] tracking-[0.06em] text-cream">{p.title}</div>
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

  if (!connected) {
    return (
      <div className="panel hairline mx-auto mt-8 w-full max-w-[440px] border px-6 py-6 text-center">
        <div className="font-display text-[22px] tracking-[0.04em] text-cream">Connect to wager</div>
        <p className="mx-auto mt-1.5 max-w-[340px] font-body text-[14px] leading-snug text-cream-dim">
          CHIP is free mock test money — connect a wallet to place a wager on the verdict.
        </p>
        <button
          type="button"
          onClick={() => void api.connect()}
          disabled={s.wallet.status === "connecting"}
          className="mt-5 rounded-sm border border-line-2 px-5 py-2 font-mono text-[12px] uppercase tracking-[0.16em] text-cream-dim transition-colors hover:border-gilt hover:text-gilt disabled:opacity-60"
        >
          {s.wallet.status === "connecting" ? "Connecting…" : "Connect wallet"}
        </button>
      </div>
    );
  }

  // Gasless explained in plain words — three states the toggle can be in.
  const gaslessOn = api.gasless && relayFunded;
  const gaslessExplain = !relayFunded
    ? "Relayer is out of 0G — wagers use your own wallet for gas."
    : api.gasless
      ? "On — the relayer pays gas; just sign to wager, no 0G needed."
      : "Off — you pay your own gas in 0G when you wager.";

  return (
    <div className="panel hairline mx-auto mt-8 w-full max-w-[440px] border px-6 py-5 text-left">
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow">Wallet</span>
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

      {relayLive ? (
        <div className="mt-4 border-t border-line pt-4">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-cream-dim">Gas-free betting</span>
            <button
              type="button"
              onClick={() => api.setGasless(!api.gasless)}
              disabled={!relayFunded}
              className={[
                "rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors disabled:opacity-50",
                gaslessOn
                  ? "border-gilt/60 text-gilt"
                  : "border-line-2 text-mute hover:border-gilt hover:text-gilt",
              ].join(" ")}
            >
              {gaslessOn ? "On" : "Off"}
            </button>
          </div>
          <p className="mt-1.5 font-body text-[13px] leading-snug text-mute">{gaslessExplain}</p>
        </div>
      ) : (
        <p className="mt-3 font-body text-[13px] leading-snug text-mute">
          CHIP is mock test money — wagers settle in it; gas is paid in 0G.
        </p>
      )}
    </div>
  );
}
