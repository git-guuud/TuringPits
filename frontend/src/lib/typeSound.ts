/**
 * Procedural game audio — no asset files, no network. Everything here is synthesized live with the
 * Web Audio API. Two layers share one context and one mute flag:
 *   - The typewriter: each revealed keystroke triggers a short filtered-noise "clack"; a completed
 *     speech gets a soft carriage-return "ding" (`clickKey` / `bell`).
 *   - The dramatic stings that punctuate the match's key beats — a gavel on the verdict, a dusk/dawn
 *     sting on the day↔night swing, a heavy thud when a seat falls, and a win/lose cue on settle
 *     (`gavel` / `nightFall` / `dayBreak` / `bodyFall` / `winSting` / `loseSting`).
 *
 * Browsers block audio until the first user gesture, so the context is created lazily and resumed on
 * the first pointer/key interaction; every emitter no-ops while the context is still suspended, so
 * nothing ever autoplays before the spectator has interacted.
 *
 * Mute state is persisted to localStorage so a spectator's choice survives a reload, and ALL of the
 * above respect it. The typewriter hook calls `clickKey()` / `bell()`; the Court fires the stings;
 * the UI toggle calls `getMuted()` / `setMuted()`.
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
    master.gain.value = 0.5; // 0.5× — softer typewriter clacks/bell
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

// ── dramatic stings ────────────────────────────────────────────────────────────────────────────
// One-shot accents synthesized from the same context/master/mute as the typewriter, so the existing
// sound toggle covers them and they share its autoplay guard. Each public sting bails when muted or
// before the context is running; the two helpers below are the building blocks.

type Audio = { ctx: AudioContext; master: GainNode; noise: AudioBuffer };

/** A single decaying oscillator note routed through the shared master gain — the stings' voice. */
function tone(
  a: Audio,
  opts: { freq: number; dur: number; peak: number; delay?: number; type?: OscillatorType; endFreq?: number; attack?: number },
): void {
  const { freq, dur, peak, delay = 0, type = "sine", endFreq, attack } = opts;
  const t = a.ctx.currentTime + delay;
  const osc = a.ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (endFreq != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur); // pitch glide
  const gain = a.ctx.createGain();
  const atk = attack ?? Math.min(0.012, dur * 0.2);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + atk);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain);
  gain.connect(a.master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** A short filtered-noise transient — the percussive "impact" layer of a knock or a thud. */
function transient(a: Audio, opts: { dur: number; peak: number; freq: number; type?: BiquadFilterType; delay?: number }): void {
  const { dur, peak, freq, type = "lowpass", delay = 0 } = opts;
  const t = a.ctx.currentTime + delay;
  const src = a.ctx.createBufferSource();
  src.buffer = a.noise;
  src.loop = true; // the noise buffer is ~60ms; loop it so longer transients don't run dry
  const filt = a.ctx.createBiquadFilter();
  filt.type = type;
  filt.frequency.value = freq;
  const gain = a.ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filt);
  filt.connect(gain);
  gain.connect(a.master);
  src.start(t);
  src.stop(t + dur + 0.02);
}

/** Gavel double-rap — the verdict lands. Two sharp wooden knocks, each a low body + a bright crack. */
export function gavel(): void {
  if (muted()) return;
  const a = audio();
  if (!a || a.ctx.state !== "running") return;
  for (const delay of [0, 0.12]) {
    transient(a, { delay, dur: 0.05, peak: 0.5, freq: 2200, type: "bandpass" }); // the crack
    tone(a, { delay, freq: 210, endFreq: 120, dur: 0.13, peak: 0.6, type: "triangle", attack: 0.003 }); // the body
  }
}

/** Heavy low thud — a seat falls. Impact transient + a fast pitch-down sine, ominous and brief. */
export function bodyFall(): void {
  if (muted()) return;
  const a = audio();
  if (!a || a.ctx.state !== "running") return;
  transient(a, { dur: 0.09, peak: 0.4, freq: 900, type: "lowpass" });
  tone(a, { freq: 150, endFreq: 46, dur: 0.34, peak: 0.6, type: "sine", attack: 0.004 });
  tone(a, { freq: 92, endFreq: 40, dur: 0.34, peak: 0.34, type: "triangle", attack: 0.004 });
}

/** Dusk stinger — day gives way to night. A soft descending minor figure, low and cold. */
export function nightFall(): void {
  if (muted()) return;
  const a = audio();
  if (!a || a.ctx.state !== "running") return;
  [330, 247, 196].forEach((freq, i) => tone(a, { freq, delay: i * 0.16, dur: 0.7, peak: 0.26, attack: 0.05 })); // E4·B3·G3 ↓
}

/** Dawn stinger — night breaks into day. A brighter rising major chime with a touch of shimmer. */
export function dayBreak(): void {
  if (muted()) return;
  const a = audio();
  if (!a || a.ctx.state !== "running") return;
  [392, 523, 659].forEach((freq, i) => {
    tone(a, { freq, delay: i * 0.11, dur: 0.5, peak: 0.24, attack: 0.01 }); // G4·C5·E5 ↑
    tone(a, { freq: freq * 2, delay: i * 0.11, dur: 0.34, peak: 0.05, attack: 0.01 }); // octave shimmer
  });
}

/** Triumphant settle sting — the spectator's wager came in. A quick rising major arpeggio + sparkle. */
export function winSting(): void {
  if (muted()) return;
  const a = audio();
  if (!a || a.ctx.state !== "running") return;
  [523, 659, 784, 1047].forEach((freq, i) => {
    tone(a, { freq, delay: i * 0.1, dur: 0.5, peak: 0.24, type: "triangle", attack: 0.008 }); // C5·E5·G5·C6 ↑
    tone(a, { freq: freq * 2, delay: i * 0.1, dur: 0.3, peak: 0.05, attack: 0.008 });
  });
}

/** Somber settle sting — the wager was lost. A slow descending minor figure with a darker sub tail. */
export function loseSting(): void {
  if (muted()) return;
  const a = audio();
  if (!a || a.ctx.state !== "running") return;
  [440, 349, 262].forEach((freq, i) => {
    tone(a, { freq, delay: i * 0.18, dur: 0.8, peak: 0.26, attack: 0.02 }); // A4·F4·C4 ↓
    tone(a, { freq: freq * 0.5, delay: i * 0.18, dur: 0.8, peak: 0.12, type: "triangle", attack: 0.02 }); // sub
  });
}
