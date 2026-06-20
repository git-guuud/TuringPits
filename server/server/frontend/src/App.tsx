import { useMatch } from "./state/matchStore.js";
import { Masthead } from "./components/tribunal/Masthead.js";
import { Bench } from "./components/tribunal/Bench.js";
import { Court } from "./components/tribunal/Court.js";
import { Verdict } from "./components/tribunal/Verdict.js";
import { Record } from "./components/tribunal/Record.js";
import { EvidenceTimeline } from "./components/tribunal/EvidenceTimeline.js";

export function App() {
  const api = useMatch();
  const s = api.state;

  return (
    <main className="mx-auto max-w-[1320px] px-6 pb-28">
      <Masthead s={s} />

      {/* THE BENCH · THE COURT · (THE VERDICT + THE RECORD) */}
      <div className="mt-5 grid grid-cols-1 gap-px bg-line lg:grid-cols-[232px_1fr_300px]">
        <Bench s={s} />
        <Court s={s} />
        <div className="flex flex-col gap-px">
          <Verdict api={api} />
          <Record s={s} />
        </div>
      </div>

      <EvidenceTimeline s={s} />

      <div className="mt-4 flex items-center justify-between px-1">
        <span className="eyebrow !text-[9px] !tracking-[0.2em]">Turing Pits · The Tribunal</span>
        <span className="eyebrow !text-[9px] !tracking-[0.2em]">
          {s.isMock ? "Evidence replayed from captured match · 0G" : "Evidence immutable & publicly auditable · 0G"}
        </span>
      </div>
    </main>
  );
}
