/**
 * App-wide transaction toaster. The per-panel receipt/error lines (Verdict footer, History header)
 * are great when that panel stays on screen — but a wager placed from the mobile Wagers sheet
 * vanishes the moment the sheet closes. This watches the single global `tx` state and surfaces a
 * transient toast for every wager/claim so the confirmation (and its on-chain receipt) is never
 * lost. Mounted once in App, alive on every route.
 */
import { useEffect, useRef, useState } from "react";
import type { MatchApi } from "../state/matchStore.js";
import { explorerTx } from "../lib/contract.js";

type ToastKind = "pending" | "success" | "error";
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  href?: string;
  hash?: string;
}

let nextId = 1;

export function TxToaster({ api }: { api: MatchApi }) {
  const { tx } = api.state;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pendingId = useRef<number | null>(null);
  // Seed "already seen" with the current values so an in-flight/old tx doesn't toast on mount.
  const seenHash = useRef<string | undefined>(tx.lastHash);
  const seenError = useRef<string | undefined>(tx.error);
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const remove = (id: number) => {
    setToasts((cur) => cur.filter((x) => x.id !== id));
    const h = timers.current[id];
    if (h) {
      clearTimeout(h);
      delete timers.current[id];
    }
  };
  const push = (t: Omit<Toast, "id">, ttl?: number): number => {
    const id = nextId++;
    setToasts((cur) => [...cur, { ...t, id }]);
    if (ttl) timers.current[id] = setTimeout(() => remove(id), ttl);
    return id;
  };

  // A sticky "confirming" toast for the duration of an in-flight tx.
  useEffect(() => {
    if (tx.pending && pendingId.current == null) {
      pendingId.current = push({ kind: "pending", text: "Confirming transaction…" });
    } else if (!tx.pending && pendingId.current != null) {
      remove(pendingId.current);
      pendingId.current = null;
    }
  }, [tx.pending]);

  // A confirmed tx → success toast carrying the explorer receipt.
  useEffect(() => {
    if (tx.lastHash && tx.lastHash !== seenHash.current && !tx.pending) {
      seenHash.current = tx.lastHash;
      push({ kind: "success", text: "Transaction confirmed.", href: explorerTx(tx.lastHash), hash: tx.lastHash }, 7000);
    }
  }, [tx.lastHash, tx.pending]);

  // A new error → error toast.
  useEffect(() => {
    if (tx.error && tx.error !== seenError.current) {
      seenError.current = tx.error;
      push({ kind: "error", text: tx.error }, 9000);
    } else if (!tx.error) {
      seenError.current = undefined;
    }
  }, [tx.error]);

  // Clear any outstanding timers on unmount.
  useEffect(() => {
    const t = timers.current;
    return () => Object.values(t).forEach(clearTimeout);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={[
            "pointer-events-auto flex w-full max-w-sm items-center gap-2.5 border px-3.5 py-2.5 shadow-lg",
            t.kind === "error"
              ? "border-convict/60 bg-ink-2 text-convict"
              : t.kind === "success"
                ? "border-acquit/60 bg-ink-2 text-acquit"
                : "border-gilt/50 bg-ink-2 text-gilt",
          ].join(" ")}
        >
          <span className={["font-mono text-[12px]", t.kind === "pending" ? "animate-pulse" : ""].join(" ")}>
            {t.kind === "pending" ? "◷" : t.kind === "success" ? "✓" : "⚠"}
          </span>
          <div className="min-w-0 flex-1 font-mono text-[11.5px] leading-snug tracking-[0.04em]">
            {t.text}
            {t.hash && (
              <span className="text-mute">
                {" · "}
                {t.hash.slice(0, 6)}…{t.hash.slice(-4)}
              </span>
            )}
          </div>
          {t.href && (
            <a
              href={t.href}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 font-mono text-[11px] underline-offset-2 hover:underline"
            >
              receipt ↗
            </a>
          )}
          {t.kind !== "pending" && (
            <button
              type="button"
              onClick={() => remove(t.id)}
              aria-label="Dismiss"
              className="shrink-0 font-mono text-[14px] leading-none text-mute transition-colors hover:text-cream"
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
