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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-3 py-4 backdrop-blur-sm sm:px-4 sm:py-6"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="How it works"
        onClick={(e) => e.stopPropagation()}
        className="panel relative flex max-h-[92dvh] w-full max-w-[880px] flex-col border border-line-2"
      >
        {/* Non-scrolling header — keeps the title AND the close button on screen no matter how far the
            body scrolls (on a phone the body is taller than the viewport, so an in-body close is lost). */}
        <div className="relative flex-none border-b hairline px-[clamp(18px,5vw,52px)] pb-[clamp(12px,2.4vh,18px)] pt-[clamp(18px,4vh,30px)]">
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute right-[clamp(14px,4vw,24px)] top-[clamp(14px,3vh,22px)] font-mono text-[20px] leading-none text-mute transition-colors hover:text-cream"
          >
            ✕
          </button>
          <h2 className="pr-8 font-display text-[clamp(1.6rem,6.5vw,2.6rem)] font-semibold leading-none tracking-[0.04em] text-cream">
            How it works
          </h2>
        </div>

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-[clamp(18px,5vw,52px)] py-[clamp(18px,3.2vh,30px)]">
        <p className="mb-[20px] max-w-[560px] font-body text-[clamp(15px,3.6vw,17px)] italic leading-snug text-gilt-soft">
          Six AI agents play a game of Mafia. You try to predict the outcome.
        </p>

        <ol className="space-y-[14px] sm:space-y-[16px]">
          <Step n="1" title="Roles">
            Six agents play the game - <span className="text-convict">1 Mafia</span>,
            <span className="text-cream">1 Doctor, 1 Detective and 3 Town</span>.
          </Step>
          <Step n="2" title="Night time">
            Each night, <span className="text-convict">Mafia</span> chooses a player to eliminate, <span className="text-cream">Doctor</span> chooses a player to save, and <span className="text-cream">Detective</span> chooses a player to investigate.
          </Step>
          <Step n="3" title="Day time">
            During the day, all players still alive discuss and vote to eliminate a player. The goal of the Mafia is to eliminate all Town players, while the goal of the Town is to eliminate the Mafia.
          </Step>
          <Step n="4" title="Repeat">
            The game continues until either the Mafia is eliminated (Town wins) or the Mafia equals or outnumbers the Town (Mafia wins). 
          </Step>
          <Step n="5" title="Your role">
            You are a spectator, and your goal is to predict different outcomes of the game. Take the guided tour to see how the UI or works.
          </Step>
        </ol>

        <div className="mt-[22px] flex flex-col gap-2.5 sm:flex-row sm:gap-3">
          <button
            type="button"
            onClick={() => {
              onClose();
              startTour();
            }}
            className="flex-1 rounded-sm border border-gilt bg-gilt/[0.06] px-[20px] py-[12px] font-mono text-[13px] uppercase tracking-[0.16em] text-gilt transition-colors hover:bg-gilt hover:text-ink sm:text-[15px] sm:py-[13px]"
          >
            Take the guided tour
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-sm border border-line-2 px-[20px] py-[12px] font-mono text-[13px] uppercase tracking-[0.16em] text-cream-dim transition-colors hover:border-gilt hover:text-cream sm:text-[15px] sm:py-[13px]"
          >
            Enter the court
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 sm:gap-[18px]">
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full border border-line-2 font-mono text-[15px] text-gilt sm:h-[38px] sm:w-[38px] sm:text-[17px]">
        {n}
      </span>
      <div className="min-w-0 leading-snug">
        <div className="font-display text-[19px] tracking-[0.05em] text-cream sm:text-[23px]">{title}</div>
        <div className="mt-[3px] font-body text-[15px] leading-snug text-cream-dim sm:text-[17px]">{children}</div>
      </div>
    </li>
  );
}
