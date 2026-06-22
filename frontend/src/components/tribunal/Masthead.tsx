import type { ViewState } from "../../state/matchStore.js";

type Live = { label: string; dot: string; pulse: boolean; cls: string };

/** Honest liveness: reflects the real socket + match lifecycle instead of a hardcoded "LIVE". */
function liveness(s: ViewState): Live {
  const refund = s.market.state === "REFUND";
  const terminal = s.market.state === "SETTLED" || refund;
  if (terminal) {
    // A finished match still animating its buffer (late joiner) reads as Replay; otherwise closed.
    if (!s.playbackComplete && s.beats.length > 0)
      return { label: "Replay", dot: "bg-gilt", pulse: false, cls: "text-gilt" };
    return { label: refund ? "Abandoned" : "Record closed", dot: "bg-mute", pulse: false, cls: "text-mute" };
  }
  if (s.connection !== "open")
    return {
      label: s.connection === "connecting" ? "Connecting…" : "Reconnecting…",
      dot: "bg-gilt",
      pulse: true,
      cls: "text-gilt",
    };
  return { label: "In session · live", dot: "bg-convict", pulse: true, cls: "text-gilt" };
}

const phaseTag = (s: ViewState): string => {
  if (s.market.state === "REFUND") return "Mistrial · refundable";
  if (s.market.state === "SETTLED")
    return s.market.outcome === "DRAW" ? "Mistrial" : s.market.outcome === "VOID" ? "Market void" : "Sentence read";
  if (s.reveal) return "The masks fall";
  if (s.phase === "night") return `Night · round ${s.round}`;
  if (s.phase === "day") return `Day · round ${s.round}`;
  if (s.market.state === "LOCKED") return "Wagers sealed";
  return "Wagers open";
};

export function Masthead({ s, onOpenRecord }: { s: ViewState; onOpenRecord: () => void }) {
  const live = liveness(s);
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
        <button
          type="button"
          onClick={onOpenRecord}
          title="Open the record"
          className={[
            "flex items-center gap-2 rounded-full border border-line-2 px-3 py-1 font-mono text-[12px] uppercase tracking-[0.24em] transition-colors hover:border-gilt hover:text-cream",
            live.cls,
          ].join(" ")}
        >
          <span className={["h-2 w-2 rounded-full", live.dot, live.pulse ? "animate-livepulse" : ""].join(" ")} />
          {live.label}
        </button>
        <span className="font-mono text-[12px] uppercase tracking-[0.18em] text-gilt">{phaseTag(s)}</span>
        {s.isMock && (
          <span className="rounded-sm border border-gilt-soft/40 px-2 py-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-gilt-soft">
            ◈ Mock feed · replaying captured match
          </span>
        )}
      </div>
    </header>
  );
}
