import { useEffect, useRef } from "react";

// Tabbable controls inside a dialog, in DOM order. `[tabindex='-1']` is reachable by script but not Tab.
const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * The shared keyboard/focus contract every modal dialog should honour, in one place: Escape closes
 * it, Tab/Shift+Tab cycle stays trapped inside the panel, focus moves into the panel on open, and
 * returns to whatever was focused (the trigger) on close. Pairs with the focus-visible styling — a
 * keyboard user can now open, traverse, and dismiss any dialog without the focus escaping behind it.
 *
 * Attach the returned ref to the dialog *panel* (the focus boundary), not the dimmed overlay.
 */
export function useDialog<T extends HTMLElement = HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  // Hold the latest onClose without re-running the effect — callers pass inline arrows that change identity each render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;

    const restoreTo = document.activeElement as HTMLElement | null;

    // Visible, tabbable descendants in DOM order (a `position:fixed` panel's children still report an offsetParent).
    const focusables = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);

    // Pull focus into the dialog so the trap has somewhere to start; fall back to the panel itself.
    const first = focusables()[0];
    if (first) first.focus();
    else {
      panel.tabIndex = -1;
      panel.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const f = focusables();
      const firstEl = f[0];
      const lastEl = f[f.length - 1];
      if (!firstEl || !lastEl) {
        e.preventDefault(); // nothing to land on — keep focus from leaving the dialog entirely
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const inside = panel.contains(active);
      if (e.shiftKey) {
        if (active === firstEl || !inside) {
          e.preventDefault();
          lastEl.focus();
        }
      } else if (active === lastEl || !inside) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreTo?.focus?.();
    };
    // Mount/unmount only: the dialog component itself is conditionally rendered, so this runs once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return ref;
}
