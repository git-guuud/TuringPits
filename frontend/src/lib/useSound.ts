import { useState } from "react";
import { getMuted, setMuted } from "./typeSound.js";

/**
 * The sound-effects toggle, shaped like {@link useMusic} (`{ on, toggle }`) so the audio controls can
 * share one button. It governs all procedural game audio in `typeSound.ts` — the typewriter clacks
 * AND the dramatic stings (gavel, dusk/dawn, body-fall, win/lose). The actual gating lives in those
 * emitters, which read the persisted mute flag directly; this hook only mirrors it into React state
 * so the toggle re-renders. `on` means audible (the inverse of muted).
 */
export function useSound(): { on: boolean; toggle: () => void } {
  const [on, setOn] = useState(() => !getMuted());
  return {
    on,
    toggle: () =>
      setOn((prev) => {
        const next = !prev;
        setMuted(!next); // persisted flag is the muted state, the inverse of `on`
        return next;
      }),
  };
}
