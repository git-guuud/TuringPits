import type { ViewState } from "../../state/matchStore.js";

function Line({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-start gap-2.5 text-[13px] leading-snug">
      <span className={["mt-0.5 flex-none font-mono text-[11px]", done ? "text-acquit" : "text-mute-2"].join(" ")}>
        {done ? "✓" : "○"}
      </span>
      <span className="text-cream-dim">{children}</span>
    </div>
  );
}

const short = (h: string) => (h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);
const isZero = (h?: string) => !h || /^0x0+$/.test(h);

export function Record({ s }: { s: ViewState }) {
  const r = s.record;
  const settled = s.market.state === "SETTLED";
  const anyMock = s.isMock; // whole feed is the labeled replay
  const personaRoot = !isZero(r?.personaPoolRoot) ? r!.personaPoolRoot! : null;
  const transcriptRoot = !isZero(s.transcriptCID ?? undefined) ? s.transcriptCID! : null;
  const hasEvidence = personaRoot || transcriptRoot;

  return (
    <section className="panel mt-px px-5 py-5">
      <div className="eyebrow mb-4 border-b hairline pb-3">The Record</div>

      <Line done={!!r}>
        Roles sealed before session{" "}
        <span className="font-mono text-[11px] text-mute">{r ? short(r.roleCommit) : "—"}</span> — opened only at sentencing
      </Line>
      <Line done={s.attestedCount > 0}>
        Every utterance TEE-attested{" "}
        <span className="font-mono text-[11px] text-mute">
          · {s.attestedCount} {s.attestedCount === 1 ? "move" : "moves"} · 0G
        </span>
      </Line>
      <Line done={!!s.reveal}>
        Roles revealed & verified on-chain{s.reveal ? ` · ${s.reveal.winner} prevails` : ""}
      </Line>
      <Line done={settled}>Verdict settled on-chain at sentencing</Line>

      {hasEvidence && (
        <Line done={!!transcriptRoot}>
          Evidence on 0G Storage
          <span className="font-mono text-[11px] text-mute">
            {personaRoot ? ` · personas ${short(personaRoot)}` : ""}
            {transcriptRoot ? ` · transcript ${short(transcriptRoot)}` : ""}
          </span>
        </Line>
      )}

      {r && (
        <div className="mt-3.5 font-mono text-[10px] leading-relaxed text-mute">
          signer {short(r.teeSigner)} · {r.providerType}/{r.providerIdentity}
        </div>
      )}

      <div className="mt-3.5 flex gap-1.5">
        <span className="rounded-sm border border-acquit/40 px-2.5 py-1.5 font-mono text-[8.5px] uppercase tracking-[0.12em] text-acquit">
          Real on-chain
        </span>
        {anyMock && (
          <span className="rounded-sm border border-gilt-soft/40 px-2.5 py-1.5 font-mono text-[8.5px] uppercase tracking-[0.12em] text-gilt-soft">
            Mock feed · testnet
          </span>
        )}
      </div>

      {/* The honest trust caveat from STATUS.md, surfaced tastefully. */}
      <div className="mt-3.5 border-t hairline pt-3 text-[11.5px] italic leading-snug text-mute-2">
        Attestation is provider-signed and on-chain verifiable; the testnet provider runs as a
        centralized RA-TLS endpoint, not visible hardware TEE.
      </div>
    </section>
  );
}
