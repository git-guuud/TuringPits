import type { MatchApi } from "../../state/matchStore.js";
import { navigate } from "../../lib/useRoute.js";

/**
 * The lobby. The arena, the history, and the wallet were all crammed onto one screen before — this
 * is the calm entry point that routes to each. Connecting a wallet here carries through to the other
 * screens (the match store is mounted once, app-wide).
 */
export function Menu({ api }: { api: MatchApi }) {
  const s = api.state;
  const connected = s.wallet.status === "connected";
  const balance = s.wallet.balance != null ? parseFloat(s.wallet.balance) : null;
  // Gas relayer ("gasless") status. The relayer is optional — only surface the affordance when the
  // server actually runs one. `api.gasless` is the live decision (enabled + funded + not opted out).
  const relayLive = !!s.relay?.enabled;
  const relayFunded = !!s.relay?.funded;

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
          />
          <MenuCard
            kicker="The record"
            title="Battle History"
            blurb="Every past battle, its on-chain verdict, and any winnings or refunds left to collect."
            cta="Browse history ›"
            onClick={() => navigate("history")}
          />
        </div>

        <div className="mt-10 flex flex-col items-center justify-center gap-3 font-mono text-[12px] tracking-[0.08em] text-mute">
          {connected ? (
            <>
              <span>
                {s.wallet.account?.slice(0, 6)}…{s.wallet.account?.slice(-4)} · 0G Galileo
              </span>
              <div className="flex items-center gap-3">
                <span className="rounded-sm border border-line-2 px-3 py-1.5 tracking-[0.12em] text-cream-dim">
                  {balance != null ? `${balance.toFixed(2)} CHIP` : "… CHIP"}
                </span>
                <button
                  type="button"
                  onClick={() => void api.getTestTokens()}
                  disabled={s.tx.pending}
                  className="rounded-sm border border-line-2 px-3 py-1.5 uppercase tracking-[0.14em] text-cream-dim transition-colors hover:border-gilt hover:text-gilt disabled:opacity-60"
                >
                  {s.tx.pending ? "Minting…" : "Get test tokens"}
                </button>
                {relayLive && (
                  <button
                    type="button"
                    onClick={() => api.setGasless(!api.gasless)}
                    disabled={!relayFunded}
                    title={
                      !relayFunded
                        ? "Relayer is out of 0G — using your own wallet for gas"
                        : api.gasless
                          ? "Gas sponsored — click to pay your own gas instead"
                          : "Click to let the relayer pay gas (no 0G needed)"
                    }
                    className={[
                      "rounded-sm border px-3 py-1.5 uppercase tracking-[0.14em] transition-colors disabled:opacity-50",
                      api.gasless
                        ? "border-gilt/60 text-gilt"
                        : "border-line-2 text-cream-dim hover:border-gilt hover:text-gilt",
                    ].join(" ")}
                  >
                    {!relayFunded ? "⛽ Relayer empty" : api.gasless ? "⛽ Gasless on" : "⛽ Gasless off"}
                  </button>
                )}
              </div>
              <span className="text-[10px] tracking-[0.1em] text-mute/70">
                {api.gasless
                  ? "Gas sponsored — just sign to bet, no 0G needed. CHIP is mock test money."
                  : "CHIP is mock test money — wagers settle in it; gas is paid in 0G."}
              </span>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void api.connect()}
              disabled={s.wallet.status === "connecting"}
              className="rounded-sm border border-line-2 px-3 py-1.5 uppercase tracking-[0.14em] text-cream-dim transition-colors hover:border-gilt hover:text-gilt disabled:opacity-60"
            >
              {s.wallet.status === "connecting" ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
        {(s.wallet.error || s.tx.error) && (
          <div className="mt-2 font-mono text-[11px] text-convict">{s.wallet.error ?? s.tx.error}</div>
        )}
      </div>
    </main>
  );
}

function MenuCard(p: {
  kicker: string;
  title: string;
  blurb: string;
  cta: string;
  onClick: () => void;
  primary?: boolean;
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
      <div className="mt-5 font-mono text-[12px] uppercase tracking-[0.16em] text-gilt transition-transform group-hover:translate-x-0.5">
        {p.cta}
      </div>
    </button>
  );
}
