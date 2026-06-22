/**
 * Procedural typewriter audio — no asset files, no network. Each revealed keystroke triggers a
 * short filtered-noise "clack" synthesized live with the Web Audio API; a completed speech gets a
 * soft carriage-return "ding". Browsers block audio until the first user gesture, so the context is
 * created lazily and resumed on the first pointer/key interaction.
 *
 * Mute state is persisted to localStorage so a spectator's choice survives a reload. The typewriter
 * hook calls `clickKey()` / `bell()`; the UI toggle calls `getMuted()` / `setMuted()`.
 */

const MUTE_KEY = "tp-type-sound-muted";
const MIN_CLICK_MS = 58; // cadence cap so sub-20ms reveals don't become a buzz

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let lastClick = 0;
let unlockBound = false;

function muted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function getMuted(): boolean {
  return muted();
}

export function setMuted(value: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, value ? "1" : "0");
  } catch {
    /* private mode — fall back to in-memory only via the early returns below */
  }
}

/** Resume the context on the first gesture (autoplay policy) and stop listening once unlocked. */
function bindUnlock(): void {
  if (unlockBound || typeof window === "undefined") return;
  unlockBound = true;
  const resume = () => {
    ctx?.resume().catch(() => {});
    window.removeEventListener("pointerdown", resume);
    window.removeEventListener("keydown", resume);
  };
  window.addEventListener("pointerdown", resume);
  window.addEventListener("keydown", resume);
}

function audio(): { ctx: AudioContext; master: GainNode; noise: AudioBuffer } | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 1.0;
    master.connect(ctx.destination);
    // ~60ms of white noise, generated once and reused as the source for every clack.
    const len = Math.floor(ctx.sampleRate * 0.06);
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    bindUnlock();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx && master && noise ? { ctx, master, noise } : null;
}

/** A single keystroke clack: a fast-decaying bandpassed noise burst with a touch of low body. */
export function clickKey(): void {
  if (muted()) return;
  const now = performance.now();
  if (now - lastClick < MIN_CLICK_MS) return;
  lastClick = now;

  const a = audio();
  if (!a || a.ctx.state !== "running") return;
  const t = a.ctx.currentTime;

  const src = a.ctx.createBufferSource();
  src.buffer = a.noise;
  const bp = a.ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1700 + Math.random() * 1000; // per-key variation
  bp.Q.value = 0.9;
  const gain = a.ctx.createGain();
  const peak = 0.42 + Math.random() * 0.14;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
  src.connect(bp);
  bp.connect(gain);
  gain.connect(a.master);
  src.start(t);
  src.stop(t + 0.06);
}

/** The carriage-return bell, rung when a full speech finishes typing. */
export function bell(): void {
  if (muted()) return;
  const a = audio();
  if (!a || a.ctx.state !== "running") return;
  const t = a.ctx.currentTime;
  for (const [freq, level] of [[1180, 0.13], [2360, 0.07]] as const) {
    const osc = a.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const gain = a.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(level, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(gain);
    gain.connect(a.master);
    osc.start(t);
    osc.stop(t + 0.42);
  }
}
