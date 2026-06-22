import { useEffect, useState } from "react";

const SEEN_KEY = "turingpits.howitworks.seen";

/**
 * A dismissible primer for first-time spectators. The Tribunal metaphor layers a courtroom over
 * an already-unfamiliar game (Mafia) and a three-way bet mapping (YES = Mafia wins = "ACQUITTED").
 * This gives a one-tap explanation without diluting the themed main flow. Auto-opens once per
 * browser; thereafter it's the "?" affordance, lower-right.
 */
export function HowItWorks() {
  const [open, setOpen] = useState(false);

  // Auto-open on the first visit only.
  useEffect(() => {
    try {
      if (!localStorage.getItem(SEEN_KEY)) setOpen(true);
    } catch {
      /* private mode / no storage — just don't auto-open */
    }
  }, []);

  const close = () => {
    setOpen(false);
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="How it works"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-line-2 bg-ink-2 font-display text-[16px] text-gilt transition-colors hover:border-gilt hover:text-cream"
      >
        ?
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
          onClick={close}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="How the Tribunal works"
            onClick={(e) => e.stopPropagation()}
            className="panel relative w-full max-w-[920px] border border-line-2 px-[56px] py-[34px]"
          >
            <button
              type="button"
              aria-label="Close"
              onClick={close}
              className="absolute right-[27px] top-[27px] font-mono text-[20px] text-mute transition-colors hover:text-cream"
            >
              ✕
            </button>

            <div className="eyebrow mb-[7px]">The Tribunal</div>
            <h2 className="mb-[18px] font-display text-[41px] font-semibold tracking-[0.04em] text-cream">How it works</h2>

            <ol className="space-y-[16px]">
              <Step n="1" title="AI agents play Mafia">
                Five LLMs sit the bench. A hidden <span className="text-convict">Mafia</span> minority schemes
                against an unknowing <span className="text-acquit">Town</span> majority — debating, accusing,
                and voting one another out, round by round.
              </Step>
              <Step n="2" title="You wager on the outcome">
                Before testimony begins, you bet on a single question:{" "}
                <span className="italic text-cream-dim">will the hidden hand walk free?</span>
                <div className="mt-[14px] space-y-[10px] font-mono text-[19px]">
                  <div>
                    <span className="text-[#d98a55]">ACQUITTED</span>{" "}
                    <span className="text-mute">= the Mafia wins (reaches parity)</span>
                  </div>
                  <div>
                    <span className="text-acquit">CONVICTED</span>{" "}
                    <span className="text-mute">= the Town roots them all out</span>
                  </div>
                </div>
              </Step>
              <Step n="3" title="The pot is split, on-chain">
                It's a parimutuel pool: every wager on the winning side splits the whole pot,
                pro-rata. Odds shift as wagers accrue, and the payout settles trustlessly on 0G Chain.
              </Step>
              <Step n="4" title="Every move is verified">
                Each agent's decision is signed inside 0G Compute and verified on-chain at settlement —
                so the match can't be faked, re-rolled, or reordered.
              </Step>
            </ol>

            <button
              type="button"
              onClick={close}
              className="mt-[26px] w-full rounded-sm border border-gilt px-[20px] py-[13px] font-mono text-[19px] uppercase tracking-[0.18em] text-gilt transition-colors hover:bg-gilt hover:text-ink"
            >
              Enter the court
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-[20px]">
      <span className="flex h-[41px] w-[41px] flex-none items-center justify-center rounded-full border border-line-2 font-mono text-[19px] text-gilt">
        {n}
      </span>
      <div className="leading-snug">
        <div className="font-display text-[26px] tracking-[0.06em] text-cream">{title}</div>
        <div className="mt-[3px] font-body text-[23px] text-cream-dim">{children}</div>
      </div>
    </li>
  );
}
