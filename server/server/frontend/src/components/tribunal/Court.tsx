import { motion } from "framer-motion";
import type { ViewState } from "../../state/matchStore.js";
import { useTypewriter } from "../../lib/useTypewriter.js";

/** Highlight the two recurring tells from the captured speeches without parsing meaning. */
function renderSpeech(text: string) {
  const parts = text.split(/(watching|Mafia tell)/g);
  return parts.map((p, i) =>
    p === "watching" || p === "Mafia tell" ? (
      <span key={i} className="text-gilt">
        {p}
      </span>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

interface Scene {
  title: string;
  note: string;
  name: string;
  role: string;
  body: string;
  lamp: "day" | "night";
}

function sceneFor(s: ViewState): Scene {
  if (s.market.state === "SETTLED")
    return {
      title: "The court rises",
      note: "the record stands, publicly auditable",
      name: "CASE CLOSED",
      role: "entered into evidence",
      body: "The sentence is entered into evidence, sealed and public. The court rises. Winners may claim against the chain.",
      lamp: "day",
    };
  if (s.reveal)
    return {
      title: "The masks fall",
      note: "each role read into the record",
      name: "THE SENTENCE",
      role: "the masks come off",
      body:
        s.reveal.winner === "MAFIA"
          ? "The hidden hand reached parity in the dark. The Town named them too late — the Mafia prevails."
          : "The Town rooted out every hidden hand before parity. The Mafia does not walk — they are convicted.",
      lamp: "day",
    };
  if (s.currentTurn) {
    const persona = s.personas.find((p) => p.seat === s.currentTurn!.seat);
    return {
      title: "Sworn testimony",
      note: `${s.phase === "night" ? "under the night lamp" : "the table turns to them"}`,
      name: (persona?.name ?? `Seat ${s.currentTurn.seat}`).toUpperCase(),
      role: persona?.blurb ?? "",
      body: s.currentTurn.speech,
      lamp: s.phase === "night" ? "night" : "day",
    };
  }
  if (s.market.state === "LOCKED")
    return {
      title: "Night falls",
      note: "wagers sealed at nightfall",
      name: "NIGHTFALL",
      role: "the table holds its breath",
      body: "The doors are barred. No further wagers. The hidden hand chooses, and the night keeps its secret.",
      lamp: "night",
    };
  return {
    title: "The court convenes",
    note: "wagers open before testimony begins",
    name: "THE COURT",
    role: "sworn under commitment",
    body: "The seats are sworn. The hidden hand is sealed in the record. Wagers, now, before the first night falls.",
    lamp: "day",
  };
}

export function Court({ s }: { s: ViewState }) {
  const scene = sceneFor(s);
  const { shown, done } = useTypewriter(scene.body);
  const att = s.currentTurn?.attestation;

  return (
    <section className="panel relative flex min-h-[520px] flex-col items-center overflow-hidden px-8 pb-8 pt-3.5">
      {/* the banker's lamp — signature element */}
      <motion.div
        aria-hidden
        animate={{ opacity: scene.lamp === "night" ? 0.5 : 1 }}
        transition={{ duration: 1.1 }}
        className="pointer-events-none absolute -top-10 left-1/2 h-[420px] w-[560px] -translate-x-1/2 blur-[2px]"
        style={{
          background:
            "radial-gradient(closest-side, rgba(240,197,82,.20), rgba(240,197,82,.06) 45%, transparent 72%)",
        }}
      >
        <span
          className="absolute left-1/2 top-[30px] h-5 w-[13px] -translate-x-1/2 rounded-[50%_50%_48%_48%]"
          style={{
            background: "radial-gradient(circle at 50% 35%, #fff0c0, #f0c552 55%, #9c7c20)",
            boxShadow: "0 0 22px 6px rgba(240,197,82,.5)",
          }}
        />
      </motion.div>

      <div className="relative z-10 mb-7 mt-1.5 text-center">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-gilt">{scene.title}</div>
        <div className="mt-1.5 font-body text-[13px] italic text-mute">{scene.note}</div>
      </div>

      <motion.h2
        key={scene.name}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative z-10 text-center font-display text-[46px] font-bold leading-none tracking-[0.2em] text-cream"
        style={{ textShadow: "0 2px 30px rgba(240,197,82,.18)" }}
      >
        {scene.name}
      </motion.h2>
      <div className="relative z-10 mb-7 mt-2.5 text-center font-body text-[15px] italic text-gilt-soft">
        <span className="mx-2 text-mute-2">—</span>
        {scene.role}
        <span className="mx-2 text-mute-2">—</span>
      </div>

      <blockquote className="relative z-10 min-h-[150px] max-w-[560px] text-center font-body text-[23px] italic leading-[1.62] text-cream">
        {renderSpeech(shown)}
        {!done && <span className="ml-px inline-block h-[1.05em] w-0.5 animate-blink align-[-0.16em] bg-gilt" />}
      </blockquote>

      {att && (
        <span className="relative z-10 mt-7 inline-flex items-center gap-2 rounded-sm border border-line-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-mute">
          <span
            className={[
              "h-1.5 w-1.5 rounded-full",
              att.source === "0g-tee" ? "bg-acquit shadow-[0_0_8px_rgba(127,160,126,0.8)]" : "bg-gilt-soft",
            ].join(" ")}
          />
          {att.source === "0g-tee" ? "Sworn & witnessed · 0G attested" : "Local key · MOCK-local"} · {att.signerAddress.slice(0, 6)}…{att.signerAddress.slice(-4)}
        </span>
      )}
    </section>
  );
}
