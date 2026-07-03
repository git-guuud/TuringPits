import { useEffect, useRef } from "react";
import type { ViewState } from "../../state/matchStore.js";

/**
 * The full testimony log. The Court stage only ever shows the *current* speech; this panel
 * replays every prior utterance from `feed` so a spectator who joins (or looks away) mid-match
 * can catch up before wagering. Toggled from the Court — see `Court.tsx`.
 */
export function Testimony({ s }: { s: ViewState }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  // Only the day speech the stage has reached — deliberation contributions and the votes that
  // follow them. Night carries no speech, and nothing the playback hasn't shown yet is revealed.
  type Entry = {
    seat: number;
    speech: string;
    round: number;
    kind: "discussion" | "claim" | "vote";
    target: number | null;
    source: "0g-tee" | "MOCK-local" | null;
  };
  const shown: Entry[] = s.beats.slice(0, s.cursor + 1).flatMap((b): Entry[] => {
    if (b.kind === "discussion")
      return [{ seat: b.seat, speech: b.speech, round: b.round, kind: "discussion" as const, target: null, source: null }];
    if (b.kind === "claim")
      return [{ seat: b.seat, speech: b.speech, round: b.round, kind: "claim" as const, target: null, source: null }];
    if (b.kind === "turn")
      return [
        {
          seat: b.turn.seat,
          speech: b.turn.speech,
          round: b.turn.decision.round,
          kind: "vote" as const,
          target: b.turn.decision.action === "vote" ? b.turn.decision.target : null,
          source: b.turn.attestation.source,
        },
      ];
    return [];
  });

  // Keep the latest testimony in view as new turns stream in.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [shown.length]);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-ink/95 backdrop-blur-sm">
      <div className="flex-1 overflow-y-auto px-7 py-6">
        {shown.length === 0 ? (
          <div className="eyebrow !tracking-[0.1em] text-mute">no testimony yet — the court has not been called to order</div>
        ) : (
          shown.map((entry, i) => {
            const persona = s.personas.find((p) => p.seat === entry.seat);
            const name = (persona?.name ?? `Seat ${entry.seat}`).toUpperCase();
            const tag = `Day ${entry.round} · ${entry.kind === "discussion" ? "deliberation" : entry.kind === "claim" ? "Detective claim" : "vote"}`;
            const targetName =
              entry.target != null
                ? (s.personas.find((p) => p.seat === entry.target)?.name ?? `Seat ${entry.target}`)
                : null;
            return (
              <div key={i} className="mb-5 border-l-2 border-line-2 pl-4">
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="font-display text-[16px] tracking-[0.1em] text-cream">{name}</span>
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-mute-2">· {tag}</span>
                  {/* Provenance dot only for signed votes; deliberation is unsigned public speech. */}
                  {entry.source && (
                    <span
                      aria-label={entry.source === "0g-tee" ? "0G attested" : "local key"}
                      className={[
                        "ml-auto h-1.5 w-1.5 flex-none rounded-full",
                        entry.source === "0g-tee" ? "bg-acquit shadow-[0_0_6px_rgba(127,160,126,0.7)]" : "bg-gilt-soft",
                      ].join(" ")}
                    />
                  )}
                </div>
                <div className="font-body text-[16px] italic leading-[1.5] text-cream-dim">{entry.speech}</div>
                {targetName && (
                  <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.16em] text-gilt">
                    ▸ votes {targetName}
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
