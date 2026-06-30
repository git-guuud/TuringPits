import { CATCHUP_THRESHOLD, type ViewState } from "../../state/matchStore.js";

type Live = { label: string; dot: string; pulse: boolean; cls: string };

/** Honest liveness: reflects the real socket + match lifecycle instead of a hardcoded "LIVE". */
export function liveness(s: ViewState): Live {
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
  // The stage trails the latest beat (it paces playback) — say so plainly while catching up, so the
  // "live" badge never claims the viewer is current when they're watching a replay of earlier beats.
  if (!s.playbackComplete && s.pendingBeats >= CATCHUP_THRESHOLD)
    return { label: "Replaying · behind live", dot: "bg-gilt", pulse: true, cls: "text-gilt" };
  return { label: "In session · live", dot: "bg-convict", pulse: true, cls: "text-gilt" };
}

export const phaseTag = (s: ViewState): string => {
  if (s.market.state === "REFUND") return "Mistrial · refundable";
  if (s.market.state === "SETTLED")
    return s.market.outcome === "DRAW" ? "Mistrial" : s.market.outcome === "VOID" ? "Market void" : "Sentence read";
  if (s.reveal) return "The masks fall";
  if (s.phase === "night") return `Night · round ${s.round}`;
  if (s.phase === "day") return `Day · round ${s.round}`;
  if (s.market.state === "LOCKED") return "Wagers sealed";
  return "Wagers open";
};

export function Masthead({ s }: { s: ViewState }) {
  return (
    <header className="flex items-end justify-between border-b hairline px-1 pb-3 pt-3">
      <div>
        <h1 className="font-display text-[28px] font-semibold uppercase leading-none tracking-[0.34em] text-gilt">
          Turing Pits
        </h1>
      </div>
      <div className="flex flex-col items-end gap-2">
        <div className="eyebrow text-right">
          The People v. The Hidden Hand{s.nonce ? ` · case ${s.nonce.slice(-6)}` : ""}
        </div>
        {s.isMock && (
          <span className="rounded-sm border border-gilt-soft/40 px-2 py-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-gilt-soft">
            ◈ Mock feed · replaying captured match
          </span>
        )}
      </div>
    </header>
  );
}
