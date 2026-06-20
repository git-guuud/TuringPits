import { motion } from "framer-motion";
import type { ViewState } from "../../state/matchStore.js";
import type { Role } from "../../lib/types.js";

const initialOf = (name: string) => name.charAt(0).toUpperCase();

function roleLabel(role: Role): { text: string; cls: string } {
  if (role === "MAFIA") return { text: "MAFIA", cls: "text-convict" };
  return { text: role.charAt(0) + role.slice(1).toLowerCase(), cls: "text-acquit" };
}

export function Bench({ s }: { s: ViewState }) {
  return (
    <section className="panel px-5 py-5">
      <div className="eyebrow mb-4 border-b hairline pb-3">The Bench</div>
      <div>
        {s.seats.map((seat) => {
          const persona = s.personas.find((p) => p.seat === seat.id);
          const speaking = s.speakingSeat === seat.id && seat.alive;
          const role = s.reveal?.roles[seat.id];
          const status = !seat.alive ? "Recused" : speaking ? "Testifying" : "Seated";

          return (
            <motion.div
              key={seat.id}
              layout
              animate={{ opacity: seat.alive ? 1 : 0.55 }}
              className={[
                "-mx-2.5 flex items-center gap-3 border-l-2 px-2.5 py-2.5 transition-colors duration-300",
                speaking ? "border-gilt bg-gradient-to-r from-gilt/10 to-transparent" : "border-transparent",
              ].join(" ")}
            >
              <span
                className={[
                  "flex h-6 w-6 flex-none items-center justify-center rounded-full border font-display text-[15px] font-semibold",
                  speaking ? "border-gilt text-gilt shadow-[0_0_14px_rgba(201,162,63,0.28)]" : "border-line-2 text-mute",
                ].join(" ")}
              >
                {persona ? initialOf(persona.name) : seat.id}
              </span>

              <span className="leading-tight">
                <span
                  className={[
                    "font-display text-[16px] font-semibold tracking-[0.14em]",
                    !seat.alive ? "text-mute-2 line-through decoration-convict" : speaking ? "text-lamp" : "text-cream",
                  ].join(" ")}
                >
                  {persona?.name ?? `Seat ${seat.id}`}
                </span>
                <br />
                <span className={["text-[12.5px] italic", !seat.alive ? "text-mute-2" : "text-mute"].join(" ")}>
                  {persona?.blurb ?? ""}
                </span>
              </span>

              <span className="ml-auto text-right">
                {role ? (
                  <span className={["font-display text-[12px] tracking-[0.1em]", roleLabel(role).cls].join(" ")}>
                    {roleLabel(role).text}
                  </span>
                ) : (
                  <span className="eyebrow !text-[8.5px] !tracking-[0.18em]">{status}</span>
                )}
              </span>
            </motion.div>
          );
        })}
        {s.seats.length === 0 && <div className="eyebrow !tracking-[0.1em]">awaiting the docket…</div>}
      </div>
    </section>
  );
}
