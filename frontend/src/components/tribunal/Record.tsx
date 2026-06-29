import { useEffect, useState } from "react";
import type { ViewState } from "../../state/matchStore.js";
import { useDialog } from "../../lib/useDialog.js";
import {
  betTokenAddress,
  explorerAddress,
  explorerToken,
  explorerTx,
  MARKET_ADDRESS,
  storageScanFile,
} from "../../lib/contract.js";

function Line({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start gap-4 text-[24px] leading-relaxed">
      <span className={["mt-1 flex-none font-mono text-[21px]", done ? "text-acquit" : "text-mute-2"].join(" ")}>
        {done ? "✓" : "○"}
      </span>
      <span className="text-cream-dim">{children}</span>
    </div>
  );
}

/** A clickable on-chain / 0G-Storage reference, rendered at THE RECORD's mono scale. */
function Ref({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-gilt-soft underline decoration-dotted decoration-gilt-soft/40 underline-offset-4 transition-colors hover:text-cream hover:decoration-cream/60"
    >
      {children}
      <span aria-hidden className="ml-1">↗</span>
    </a>
  );
}

const short = (h: string) => (h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);
const isZero = (h?: string) => !h || /^0x0+$/.test(h);

export function Record({ s, onClose }: { s: ViewState; onClose: () => void }) {
  const dialogRef = useDialog<HTMLElement>(onClose);
  const r = s.record;
  const settled = s.market.state === "SETTLED";
  const anyMock = s.isMock; // whole feed is the labeled replay
  const personaRoot = !isZero(r?.personaPoolRoot) ? r!.personaPoolRoot! : null;
  const transcriptRoot = !isZero(s.transcriptCID ?? undefined) ? s.transcriptCID! : null;
  const hasEvidence = personaRoot || transcriptRoot;

  // The deployed market is known up front (falls back to the canonical address before match_init);
  // the CHIP token is read from the market on-chain, so resolve it lazily for its explorer link.
  const marketAddr = s.marketAddress ?? MARKET_ADDRESS;
  const [tokenAddr, setTokenAddr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    betTokenAddress(marketAddr)
      .then((a) => alive && setTokenAddr(a))
      .catch(() => {
        /* token link is best-effort; the rest of THE RECORD stands without it */
      });
    return () => {
      alive = false;
    };
  }, [marketAddr]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="The Record"
        onClick={(e) => e.stopPropagation()}
        className="panel relative max-h-[94vh] w-full max-w-[900px] overflow-y-auto border border-line-2 px-12 py-11"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-6 top-6 font-mono text-[22px] text-mute transition-colors hover:text-cream"
        >
          ✕
        </button>

        <div className="eyebrow mb-7 border-b hairline pb-5 text-[22px]">The Record</div>

        <Line done={!!r}>
        Roles sealed before session{" "}
        <span className="font-mono text-[21px] text-mute">{r ? short(r.roleCommit) : "—"}</span> — opened only at sentencing
      </Line>
      <Line done={s.attestedCount > 0}>
        Every utterance TEE-attested{" "}
        <span className="font-mono text-[21px] text-mute">
          · {s.attestedCount} {s.attestedCount === 1 ? "move" : "moves"} · 0G
        </span>
      </Line>
      <Line done={!!s.reveal}>
        Roles revealed & verified on-chain{s.reveal ? ` · ${s.reveal.winner} prevails` : ""}
      </Line>
      <Line done={settled}>
        Verdict settled on-chain at sentencing
        {settled && s.settleTxHash && (
          <span className="font-mono text-[21px] text-mute"> · <Ref href={explorerTx(s.settleTxHash)}>{short(s.settleTxHash)}</Ref></span>
        )}
      </Line>

      {hasEvidence && (
        <Line done={!!transcriptRoot}>
          Evidence on 0G Storage
          <span className="font-mono text-[21px] text-mute">
            {personaRoot && (
              <>
                {" "}· personas <Ref href={storageScanFile(personaRoot)}>{short(personaRoot)}</Ref>
              </>
            )}
            {transcriptRoot && (
              <>
                {" "}· transcript <Ref href={storageScanFile(transcriptRoot)}>{short(transcriptRoot)}</Ref>
              </>
            )}
          </span>
        </Line>
      )}

      {/* On-chain references: the market everyone bets in, its CHIP token, and the TEE signer. */}
      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2.5 border-t hairline pt-6 font-mono text-[19px] text-mute">
        <span>
          market <Ref href={explorerAddress(marketAddr)}>{short(marketAddr)}</Ref>
        </span>
        {tokenAddr && (
          <span>
            CHIP token <Ref href={explorerToken(tokenAddr)}>{short(tokenAddr)}</Ref>
          </span>
        )}
        {r && (
          <span>
            signer <Ref href={explorerAddress(r.teeSigner)}>{short(r.teeSigner)}</Ref> · {r.providerType}/{r.providerIdentity}
          </span>
        )}
      </div>

      <div className="mt-7 flex gap-3">
        <span className="rounded-sm border border-acquit/40 px-4 py-3 font-mono text-[17px] uppercase tracking-[0.1em] text-acquit">
          Real on-chain
        </span>
        {anyMock && (
          <span className="rounded-sm border border-gilt-soft/40 px-4 py-3 font-mono text-[17px] uppercase tracking-[0.1em] text-gilt-soft">
            Mock feed · testnet
          </span>
        )}
      </div>

      {/* The honest trust caveat from STATUS.md, surfaced tastefully. */}
      <div className="mt-7 border-t hairline pt-6 text-[21px] italic leading-relaxed text-mute-2">
        Attestation is provider-signed and on-chain verifiable; the testnet provider runs as a
        centralized RA-TLS endpoint, not visible hardware TEE.
      </div>
      </section>
    </div>
  );
}
