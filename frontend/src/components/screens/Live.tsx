import { useState } from "react";
import type { MatchApi } from "../../state/matchStore.js";
import { useMusic } from "../../lib/useMusic.js";
import { navigate } from "../../lib/useRoute.js";
import { Masthead } from "../tribunal/Masthead.js";
import { Bench } from "../tribunal/Bench.js";
import { Court } from "../tribunal/Court.js";
import { Verdict } from "../tribunal/Verdict.js";
import { Record } from "../tribunal/Record.js";

/** The live arena — the bench, the court, and the verdict, fed by the live WebSocket match. */
export function Live({ api }: { api: MatchApi }) {
  const s = api.state;
  const [recordOpen, setRecordOpen] = useState(false);
  // When night falls the whole arena cools to moonlight; the gilt warmth recedes until dawn.
  const night = s.phase === "night";
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

      <div className="flex items-center gap-4 pt-3">
        <button
          type="button"
          onClick={() => navigate("menu")}
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-mute transition-colors hover:text-gilt"
        >
          ‹ Lobby
        </button>
        <button
          type="button"
          onClick={() => navigate("history")}
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-mute transition-colors hover:text-gilt"
        >
          Battle history
        </button>
      </div>

      <Masthead s={s} onOpenRecord={() => setRecordOpen(true)} />

      {/* THE BENCH · THE COURT · THE VERDICT — THE RECORD lives in a popup off the masthead */}
      <div className="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-px bg-line lg:grid-cols-[248px_1fr_384px]">
        <Bench s={s} />
        <Court s={s} advance={api.advance} skipToPresent={api.skipToPresent} />
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
    </main>
  );
}
