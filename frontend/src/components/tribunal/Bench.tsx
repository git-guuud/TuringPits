import { useState } from "react";
import { motion } from "framer-motion";
import type { ViewState } from "../../state/matchStore.js";
import type { Role } from "../../lib/types.js";

const initialOf = (name: string) => name.charAt(0).toUpperCase();

function roleLabel(role: Role): { text: string; cls: string } {
  if (role === "MAFIA") return { text: "MAFIA", cls: "text-convict" };
  return { text: role.charAt(0) + role.slice(1).toLowerCase(), cls: "text-acquit" };
}

export function Bench({ s }: { s: ViewState }) {
  const maxVotes = Math.max(0, ...Object.values(s.votes));
  const [openSeat, setOpenSeat] = useState<number | null>(null);

  return (
    <section className="panel min-h-0 overflow-y-auto px-5 py-5">
      <div className="eyebrow mb-4 border-b hairline pb-3">The Bench</div>
      <div>
        {s.seats.map((seat) => {
          const persona = s.personas.find((p) => p.seat === seat.id);
          const speaking = s.speakingSeat === seat.id && seat.alive;
          const role = s.reveal?.roles[seat.id];
          const votes = seat.alive ? s.votes[seat.id] ?? 0 : 0;
          const leading = votes > 0 && votes === maxVotes; // the seat the floor is closing on

          return (
            <motion.div
              key={seat.id}
              layout
              animate={{ opacity: seat.alive ? 1 : 0.5 }}
              role="button"
              tabIndex={0}
              onClick={() => setOpenSeat(seat.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpenSeat(seat.id);
                }
              }}
              title="View persona"
              className={[
                "-mx-2.5 flex cursor-pointer items-center gap-3 border-l-2 px-2.5 py-3 transition-colors duration-300 hover:bg-gilt/[0.06]",
                speaking ? "border-gilt bg-gradient-to-r from-gilt/10 to-transparent" : "border-transparent",
              ].join(" ")}
            >
              <span
                className={[
                  "flex h-7 w-7 flex-none items-center justify-center rounded-full border font-display text-[16px] font-semibold",
                  speaking ? "border-gilt text-gilt shadow-[0_0_14px_rgba(201,162,63,0.28)]" : "border-line-2 text-mute",
                ].join(" ")}
              >
                {persona ? initialOf(persona.name) : seat.id}
              </span>

              <span className="leading-snug">
                <span
                  className={[
                    "font-display text-[17px] font-semibold tracking-[0.12em]",
                    !seat.alive ? "text-mute-2 line-through decoration-convict" : speaking ? "text-lamp" : "text-cream",
                  ].join(" ")}
                >
                  {persona?.name ?? `Seat ${seat.id}`}
                </span>
                <br />
                <span className={["text-[13.5px] italic", !seat.alive ? "text-mute-2" : "text-mute"].join(" ")}>
                  {persona?.blurb ?? ""}
                </span>
              </span>

              <span className="ml-auto text-right">
                {role ? (
                  <span className={["font-display text-[14px] tracking-[0.08em]", roleLabel(role).cls].join(" ")}>
                    {roleLabel(role).text}
                  </span>
                ) : votes > 0 ? (
                  <span
                    title={`${votes} vote${votes > 1 ? "s" : ""}`}
                    className={["inline-flex items-center gap-1 font-mono text-[13px]", leading ? "text-convict" : "text-gilt"].join(" ")}
                  >
                    <span className="tracking-[-2px]">{"▌".repeat(Math.min(votes, 5))}</span>
                    {votes}
                  </span>
                ) : null}
              </span>
            </motion.div>
          );
        })}
        {s.seats.length === 0 && <div className="eyebrow">awaiting the docket…</div>}
      </div>

      {openSeat !== null && <SeatProfile s={s} seatId={openSeat} onClose={() => setOpenSeat(null)} />}
    </section>
  );
}

/** A popup dossier for one seat: their persona, current standing, and testimony on the record. */
function SeatProfile({ s, seatId, onClose }: { s: ViewState; seatId: number; onClose: () => void }) {
  const persona = s.personas.find((p) => p.seat === seatId);
  const seat = s.seats.find((x) => x.id === seatId);
  const alive = seat?.alive ?? true;
  const role = s.reveal?.roles[seatId];
  const votesAgainst = alive ? s.votes[seatId] ?? 0 : 0;

  // Their attributable day speech shown so far — deliberation + votes (respecting the cursor).
  const statements: string[] = [];
  for (let i = 0; i <= s.cursor; i++) {
    const b = s.beats[i];
    if (b?.kind === "turn" && b.turn.seat === seatId && b.turn.speech.trim()) statements.push(b.turn.speech.trim());
    else if (b?.kind === "discussion" && b.seat === seatId && b.speech.trim()) statements.push(b.speech.trim());
  }
  const lastWords = statements[statements.length - 1];

  const standing = role
    ? { text: roleLabel(role).text, cls: roleLabel(role).cls }
    : !alive
      ? { text: "Eliminated", cls: "text-convict" }
      : s.speakingSeat === seatId
        ? { text: "Testifying now", cls: "text-gilt" }
        : { text: "Sworn in", cls: "text-acquit" };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${persona?.name ?? `Seat ${seatId}`} — persona`}
        onClick={(e) => e.stopPropagation()}
        className="panel relative max-h-[94vh] w-full max-w-[950px] overflow-y-auto border border-line-2 px-14 py-12"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-7 top-7 font-mono text-[27px] text-mute transition-colors hover:text-cream"
        >
          ✕
        </button>

        <div className="eyebrow mb-8 border-b hairline pb-6 text-[18px]">The Bench · Seat {seatId}</div>

        <div className="flex items-center gap-7">
          <span className="flex h-28 w-28 flex-none items-center justify-center rounded-full border border-gilt font-display text-[58px] font-semibold text-gilt shadow-[0_0_18px_rgba(201,162,63,0.22)]">
            {persona ? initialOf(persona.name) : seatId}
          </span>
          <div className="leading-tight">
            <div
              className={[
                "font-display text-[44px] font-semibold tracking-[0.08em]",
                !alive ? "text-mute-2 line-through decoration-convict" : "text-cream",
              ].join(" ")}
            >
              {persona?.name ?? `Seat ${seatId}`}
            </div>
            <div className={["mt-2 font-display text-[26px] tracking-[0.1em]", standing.cls].join(" ")}>
              {standing.text}
              {votesAgainst > 0 && !role ? (
                <span className="text-mute"> · {votesAgainst} vote{votesAgainst > 1 ? "s" : ""} against</span>
              ) : null}
            </div>
          </div>
        </div>

        {persona?.blurb && (
          <p className="mt-10 font-body text-[29px] italic leading-relaxed text-cream-dim">{persona.blurb}</p>
        )}

        <div className="mt-10 border-t hairline pt-8">
          <div className="eyebrow mb-5 text-[18px]">On the record</div>
          {statements.length === 0 ? (
            <p className="text-[26px] italic text-mute">No testimony entered yet.</p>
          ) : (
            <>
              <p className="font-mono text-[22px] uppercase tracking-[0.12em] text-mute">
                {statements.length} statement{statements.length > 1 ? "s" : ""} on the floor
              </p>
              <blockquote className="mt-5 border-l-2 border-gilt/40 pl-7 text-[27px] leading-relaxed text-cream-dim">
                “{lastWords}”
              </blockquote>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
