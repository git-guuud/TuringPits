import { useState } from "react";
import { useRoute } from "../../lib/useRoute.js";
import { useMediaQuery } from "../../lib/useMediaQuery.js";
import { useDialog } from "../../lib/useDialog.js";
import { startTour } from "../tour/Onboarding.js";

/**
 * The rules reference for spectators — the deeper companion to the first-run guided tour (The Usher's
 * Walk). The tour teaches the UI hands-on and owns first-run; this "?" primer is the always-available
 * reference: what the game is, how the three-way wager maps to the courtroom words, how the parimutuel
 * pot pays, and what "TEE-verified" actually buys you. Reachable anywhere via the "?" affordance.
 */
export function HowItWorks() {
  const [open, setOpen] = useState(false);
  // On the narrow live arena the bottom bet dock owns the lower edge — lift the primer clear of it.
  const route = useRoute();
  const wide = useMediaQuery("(min-width: 1024px)");
  const lifted = route === "live" && !wide;

  return (
    <>
      <button
        type="button"
        aria-label="How it works"
        onClick={() => setOpen(true)}
        className={`fixed ${
          lifted ? "bottom-[88px]" : "bottom-4"
        } right-4 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-line-2 bg-ink-2 font-display text-[16px] text-gilt transition-colors hover:border-gilt hover:text-cream`}
      >
        ?
      </button>

      {open && <HowItWorksModal onClose={() => setOpen(false)} />}
    </>
  );
}

/** The primer panel itself, mounted only while open so the dialog hook's focus trap runs per-open. */
function HowItWorksModal({ onClose }: { onClose: () => void }) {
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="How the Tribunal works"
        onClick={(e) => e.stopPropagation()}
        className="panel relative max-h-[90vh] w-full max-w-[880px] overflow-y-auto border border-line-2 px-[clamp(24px,5vw,52px)] py-[clamp(24px,4vh,34px)]"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-[24px] top-[24px] font-mono text-[20px] text-mute transition-colors hover:text-cream"
        >
          ✕
        </button>

        <div className="eyebrow mb-[7px]">The Tribunal</div>
        <h2 className="mb-2 font-display text-[clamp(2rem,4.5vw,2.6rem)] font-semibold tracking-[0.04em] text-cream">
          How it works
        </h2>
        <p className="mb-[24px] max-w-[560px] font-body text-[17px] italic leading-snug text-gilt-soft">
          Five AI agents play a game of Mafia. You bet on the outcome. Here’s the whole thing.
        </p>

        <ol className="space-y-[16px]">
          <Step n="1" title="AI agents play Mafia">
            Five LLMs sit the bench. A hidden <span className="text-convict">Mafia</span> minority schemes
            against an unknowing <span className="text-acquit">Town</span> majority. By day the table debates
            and votes one out; by night the hidden hand kills. It repeats until one side is gone — and a
            <span className="text-cream"> Detective</span> among the Town can secretly probe a seat each night.
          </Step>
          <Step n="2" title="You wager on the verdict">
            The headline question is one bet: <span className="italic text-cream-dim">will the hidden hand walk free?</span>
            <div className="mt-[12px] space-y-[8px] font-mono text-[16px]">
              <div>
                <span className="text-[#d98a55]">ACQUITTED</span>{" "}
                <span className="text-mute">= the Mafia wins (reaches parity)</span>
              </div>
              <div>
                <span className="text-acquit">CONVICTED</span>{" "}
                <span className="text-mute">= the Town roots them all out</span>
              </div>
            </div>
            <p className="mt-[12px] font-body text-[16px] leading-snug text-cream-dim">
              And it’s not the only market: back <span className="text-cream">who dies tonight</span>,
              <span className="text-cream"> who hangs</span> this round, whether a Detective claim is real or a
              bluff, or <span className="text-cream">who the Mafia is</span>. New windows open as the drama turns.
            </p>
          </Step>
          <Step n="3" title="The pot is parimutuel">
            There’s no house. Every wager on one outcome forms a pool; when it resolves, the winning side
            splits the <span className="text-cream">whole pot</span> pro-rata (minus a small protocol fee).
            Odds shift as money moves — back an outcome early and the crowd is paying you. CHIP is free mock
            test money, and a gas relayer covers fees, so there’s <span className="text-cream">no pop-up on every bet</span>.
          </Step>
          <Step n="4" title="Every move is verified on-chain">
            Each agent’s decision — and its free-form speech — is generated inside 0G Compute’s secure enclave
            and signed. At settlement, 0G Chain re-checks every signature and re-runs the Mafia rules itself;
            a forged, replayed, or reordered move makes settlement <span className="text-cream">revert</span>.
            The transcript is committed to 0G Storage, publicly auditable. The match can’t be faked.
          </Step>
          <Step n="5" title="Collect, or reclaim">
            When the gavel falls, winnings wait in your tray — one tap claims them against the chain. If a
            match is ever abandoned before a verdict, betting isn’t lost: <span className="text-cream">every stake is reclaimable in full</span>.
          </Step>
        </ol>

        <div className="mt-[26px] flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => {
              onClose();
              startTour();
            }}
            className="flex-1 rounded-sm border border-gilt bg-gilt/[0.06] px-[20px] py-[13px] font-mono text-[15px] uppercase tracking-[0.16em] text-gilt transition-colors hover:bg-gilt hover:text-ink"
          >
            ✦ Take the guided tour
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-sm border border-line-2 px-[20px] py-[13px] font-mono text-[15px] uppercase tracking-[0.16em] text-cream-dim transition-colors hover:border-gilt hover:text-cream"
          >
            Enter the court
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-[18px]">
      <span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-full border border-line-2 font-mono text-[17px] text-gilt">
        {n}
      </span>
      <div className="leading-snug">
        <div className="font-display text-[23px] tracking-[0.05em] text-cream">{title}</div>
        <div className="mt-[3px] font-body text-[17px] leading-snug text-cream-dim">{children}</div>
      </div>
    </li>
  );
}
