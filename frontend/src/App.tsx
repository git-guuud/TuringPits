import { useState } from "react";
import { useMatch } from "./state/matchStore.js";
import { useMusic } from "./lib/useMusic.js";
import { Masthead } from "./components/tribunal/Masthead.js";
import { Bench } from "./components/tribunal/Bench.js";
import { Court } from "./components/tribunal/Court.js";
import { Verdict } from "./components/tribunal/Verdict.js";
import { Record } from "./components/tribunal/Record.js";
import { HowItWorks } from "./components/tribunal/HowItWorks.js";

export function App() {
  const api = useMatch();
  const s = api.state;
  const [recordOpen, setRecordOpen] = useState(false);
  // When night falls the whole arena cools to moonlight — a blue veil + glow crossfades over the
  // (opaque) panels, so the gilt warmth recedes until dawn. Driven purely by the playback phase.
  const night = s.phase === "night";
  // Looping background score that crossfades day↔night with the same phase signal.
  const music = useMusic(night);

  return (
    <main className="flex h-screen w-full flex-col overflow-hidden px-6 pb-4">
      {/* Moonlight veil — above the panels (z-30) so it tints them, below the modals (z-50). */}
      <div
        aria-hidden
        className={`pointer-events-none fixed inset-0 z-30 transition-opacity duration-[1400ms] ease-in-out ${
          night ? "opacity-100" : "opacity-0"
        }`}
        style={{
          background:
            "radial-gradient(900px 520px at 50% -6%, rgba(126,156,224,.20), transparent 62%)," +
            "linear-gradient(180deg, rgba(20,30,62,.34), rgba(9,14,34,.46))",
        }}
      />
      <Masthead s={s} onOpenRecord={() => setRecordOpen(true)} />

      {/* THE BENCH · THE COURT · THE VERDICT — THE RECORD lives in a popup off the masthead */}
      <div className="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-px bg-line lg:grid-cols-[248px_1fr_384px]">
        <Bench s={s} />
        <Court s={s} advance={api.advance} />
        <Verdict api={api} />
      </div>

      {recordOpen && <Record s={s} onClose={() => setRecordOpen(false)} />}

      {/* Background-music toggle — mirrors the How-It-Works button on the opposite corner. */}
      <button
        type="button"
        onClick={music.toggle}
        aria-label={music.on ? "Pause background music" : "Play background music"}
        aria-pressed={music.on}
        className={`fixed bottom-4 left-4 z-40 flex h-9 w-9 items-center justify-center rounded-full border bg-ink-2 text-[15px] transition-colors hover:border-gilt hover:text-cream ${
          music.on ? "border-gilt text-gilt" : "border-line-2 text-mute"
        }`}
      >
        ♪
      </button>

      <HowItWorks />
    </main>
  );
}
