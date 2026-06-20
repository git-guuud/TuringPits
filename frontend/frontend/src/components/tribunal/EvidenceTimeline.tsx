import { motion } from "framer-motion";
import type { ViewState, TimelineEvent } from "../../state/matchStore.js";
import type { Role } from "../../lib/types.js";

function eventLabel(e: TimelineEvent, personas: ViewState["personas"]): string {
  switch (e.kind) {
    case "sealed":
      return "Sealed";
    case "locked":
      return "Wagers locked";
    case "elimination": {
      const name = personas.find((p) => p.seat === e.seat)?.name ?? `Seat ${e.seat}`;
      return `${name} falls · ${e.phase === "night" ? "night" : "day"} ${e.round}`;
    }
    case "reveal":
      return "Masks fall";
    case "settlement":
      return `Settled · ${e.winningSide === "YES" ? "Mafia" : "Town"}`;
  }
}

function railNarration(s: ViewState): { eyebrow: string; phase: string; em: string } {
  if (s.market.state === "SETTLED") return { eyebrow: "Case closed", phase: "Sentence entered", em: s.reveal ? `${s.reveal.winner} prevailed` : "" };
  if (s.reveal) return { eyebrow: "At dawn", phase: "The sentence read", em: "the record is opened" };
  if (s.phase === "night") return { eyebrow: `Round ${s.round} · night`, phase: "Nightfall", em: "the hand moves in the dark" };
  if (s.phase === "day") return { eyebrow: `Round ${s.round} · day`, phase: "The floor", em: "the table debates and votes" };
  if (s.market.state === "LOCKED") return { eyebrow: "Before the first night", phase: "Wagers sealed", em: "the docket is set" };
  return { eyebrow: "Pre-match", phase: "Seats sworn", em: "roles sealed in the record" };
}

function roleFor(role: Role): { glyph: string; cls: string } {
  if (role === "MAFIA") return { glyph: "✚", cls: "border-convict bg-gradient-to-b from-convict/15 to-ink-3 text-convict" };
  return { glyph: "✦", cls: "border-line-2 text-acquit" };
}

export function EvidenceTimeline({ s }: { s: ViewState }) {
  const n = railNarration(s);
  const revealed = s.reveal?.roles ?? null;

  return (
    <div className="mt-5">
      {/* event ribbon */}
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        {s.timeline.map((e, i) => (
          <span
            key={i}
            className={[
              "rounded-sm border px-2 py-1 font-mono text-[8.5px] uppercase tracking-[0.12em]",
              e.kind === "reveal" || e.kind === "settlement" ? "border-gilt/40 text-gilt" : "border-line-2 text-mute",
            ].join(" ")}
          >
            {eventLabel(e, s.personas)}
          </span>
        ))}
        {s.timeline.length === 0 && <span className="eyebrow !tracking-[0.1em]">evidence accrues as the match proceeds</span>}
      </div>

      {/* rail: narration + sentence docket */}
      <div className="flex items-center justify-between border hairline panel px-5 py-4">
        <div>
          <div className="eyebrow mb-1.5">{n.eyebrow}</div>
          <div className="font-display text-[20px] tracking-[0.06em] text-cream">
            {n.phase}
            {n.em && <span className="ml-2 text-[15px] italic text-gilt-soft">· {n.em}</span>}
          </div>
        </div>

        <div className="flex gap-2">
          {s.seats.map((seat) => {
            const persona = s.personas.find((p) => p.seat === seat.id);
            const role = revealed?.[seat.id];
            const rv = role ? roleFor(role) : null;
            return (
              <motion.div
                key={seat.id}
                initial={false}
                animate={{ rotateY: role ? 0 : 0, opacity: 1 }}
                className={[
                  "flex h-[70px] w-[54px] flex-col items-center justify-center gap-1 border bg-ink-3 font-mono",
                  rv ? rv.cls : "border-line-2",
                ].join(" ")}
              >
                {role ? (
                  <>
                    <span className={["font-display text-[11px] tracking-[0.08em]", role === "MAFIA" ? "text-convict" : "text-acquit"].join(" ")}>
                      {role.charAt(0) + role.slice(1).toLowerCase()}
                    </span>
                    <span className="text-[8px] tracking-[0.1em] text-mute">{persona ? persona.name.charAt(0) : seat.id}</span>
                  </>
                ) : (
                  <>
                    <span className="text-[17px] text-gilt-soft">◈</span>
                    <span className="text-[8px] tracking-[0.1em] text-mute-2">SEALED</span>
                  </>
                )}
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
