import type { ViewState } from "../../state/matchStore.js";

const phaseTag = (s: ViewState): string => {
  if (s.market.state === "SETTLED") return "Sentence read";
  if (s.reveal) return "The masks fall";
  if (s.phase === "night") return `Night · round ${s.round}`;
  if (s.phase === "day") return `Day · round ${s.round}`;
  if (s.market.state === "LOCKED") return "Wagers sealed";
  return "Wagers open";
};

export function Masthead({ s }: { s: ViewState }) {
  return (
    <header className="flex items-end justify-between border-b hairline px-1 pb-4 pt-7">
      <div>
        <div className="eyebrow mb-2">
          The People v. The Hidden Hand{s.nonce ? ` · case ${s.nonce.slice(-6)}` : ""}
        </div>
        <h1 className="font-display text-[30px] font-semibold uppercase leading-none tracking-[0.46em] text-cream">
          The Tribunal
        </h1>
        <div className="mt-2 font-body text-[15px] italic text-gilt-soft">
          {s.seats.length > 0 ? `${s.seats.length} seats sworn` : "the court convenes"} · one hand hidden · the verdict wagered
        </div>
      </div>
      <div className="flex flex-col items-end gap-2">
        <span className="flex items-center gap-2 font-mono text-[10px] tracking-[0.28em] text-gilt">
          <span className="h-1.5 w-1.5 animate-livepulse rounded-full bg-convict" />
          IN SESSION · LIVE
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-gilt">{phaseTag(s)}</span>
        {s.isMock && (
          <span className="rounded-sm border border-gilt-soft/40 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-gilt-soft">
            ◈ Mock feed · replaying captured match
          </span>
        )}
      </div>
    </header>
  );
}
