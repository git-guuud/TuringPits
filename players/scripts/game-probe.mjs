// GAME-QUALITY probe: plays a FULL live Mafia match (real 0G TEE inference) and logs every
// speech/action/vote — but NO on-chain settlement, so it never aborts on a chain issue and is
// purely about dialogue quality. Seed + nonce are FIXED by default, so the same game replays
// across prompt edits and changes are directly comparable (the model is ~greedy/deterministic).
//
//   node --env-file=.env players/scripts/game-probe.mjs
//   N=6 node --env-file=.env players/scripts/game-probe.mjs        # 1-Mafia variant
//   SEED=0x… NONCE=foo node --env-file=.env players/scripts/game-probe.mjs
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as players from "@turingpits/players";
import * as engine from "@turingpits/engine";

const RPC = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.TEE_PROVIDER_ADDRESS;
if (!KEY || !PROVIDER_ADDR) throw new Error("need COMPUTE_PRIVATE_KEY + TEE_PROVIDER_ADDRESS in .env");

const N = Number(process.env.N ?? 7); // 7 = 2 Mafia (more dynamic); 6 = 1 Mafia
// FIXED defaults so a game replays identically across prompt edits (A/B). Override to vary.
const SEED = process.env.SEED ?? "0x" + "a7".repeat(32);
const NONCE = process.env.NONCE ?? "game-probe-fixed";

// 8 vivid, voice-distinct personas (persona is the main lever that makes a greedy model's seats
// diverge — so each is a sharp, instantly-recognisable manner of speaking, not just a label).
const PERSONAS = [
  { seat: 0, name: "Ada", blurb: "a cold vote-counter; clipped, math-first, no warmth" },
  { seat: 1, name: "Boris", blurb: "a loud brawler; first to accuse, swings hard and fast" },
  { seat: 2, name: "Cleo", blurb: "a silver-tongued peacemaker who slows every rush to vote" },
  { seat: 3, name: "Dmitri", blurb: "a sardonic contrarian who distrusts the obvious read" },
  { seat: 4, name: "Esme", blurb: "a patient strategist who speaks rarely but lands hard" },
  { seat: 5, name: "Felix", blurb: "a blunt prosecutor who demands hard evidence for everything" },
  { seat: 6, name: "Greta", blurb: "a warm empath who reads tone and motive over logic" },
  { seat: 7, name: "Hugo", blurb: "a reckless gambler who loves a bold early call" },
].slice(0, N);

const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG = fileURLToPath(new URL(`../../game-${STAMP}.md`, import.meta.url));
writeFileSync(LOG, "");
const log = (s = "") => { console.log(s); appendFileSync(LOG, s + "\n"); };

// ---- Provider + the proven throttle/retry (10 req/min cap; back off on 429/funding-timeout).
const provider = await players.createZeroGDirectProvider({ privateKey: KEY, rpcUrl: RPC, providerAddress: PROVIDER_ADDR });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTransient = (m) =>
  /429|fetch failed|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|timeout|timed out|auto-funding|sub-account|502|503|504/i.test(m);
function throttled(inner, minIntervalMs = 6500) {
  let last = 0;
  return {
    teeSignerAddress: inner.teeSignerAddress,
    async complete(prompt, opts) {
      let attempts = 0;
      for (;;) {
        const wait = last + minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        try { return await inner.complete(prompt, opts); }
        catch (err) {
          const msg = [err?.message, err?.code, err?.shortMessage].filter(Boolean).join(" ") || String(err);
          if (isTransient(msg) && attempts++ < 15) {
            const backoff = /429/.test(msg) ? 30_000 : 10_000;
            console.log(`  …transient (${msg.slice(0, 60)}), retry ${attempts} in ${backoff / 1000}s`);
            await sleep(backoff);
            continue;
          }
          throw err;
        }
      }
    },
  };
}
const rateLimited = throttled(provider);

// ---- Roles from the fixed seed (hidden during play, revealed in the log header for our analysis).
const roleNames = engine.assignRoles(SEED, N);
const nameOf = (s) => PERSONAS[s].name;
log(`# Turing Pits — game-quality probe\n`);
log(`- when: ${new Date().toISOString()}`);
log(`- N=${N}, seed=\`${SEED.slice(0, 10)}…\`, nonce=\`${NONCE}\``);
log(`- ROLES (hidden from players): ${roleNames.map((r, i) => `${nameOf(i)}=${r}`).join(", ")}\n`);

const playerSeats = PERSONAS.map(() => new players.Player(rateLimited, { decisionRetries: 4 }));
let curPhase = "";
const banner = (h) => { if (h !== curPhase) { curPhase = h; log(`\n### ${h}\n`); } };

const onDiscussion = (entry, state) => {
  banner(`DAY ${entry.round} · discussion`);
  log(`**${nameOf(entry.seat)}** _(${roleNames[entry.seat]})_: ${entry.speech.trim()}`);
};
const onTurn = (turn, state) => {
  const d = turn.structuredDecision;
  banner(d.phase === "day" ? `DAY ${d.round} · vote` : `NIGHT ${d.round}`);
  const alive = state.players.filter((p) => p.alive).map((p) => nameOf(p.id));
  if (d.phase === "night") {
    log(`**${nameOf(turn.seat)}** _(${roleNames[turn.seat]})_ → ${d.action} **${nameOf(d.target)}**  ·  _secret reasoning:_ ${turn.speech.trim()}`);
  } else {
    log(`**${nameOf(turn.seat)}** _(${roleNames[turn.seat]})_ votes **${nameOf(d.target)}**: ${turn.speech.trim()}`);
  }
  if (d.phase === "night" || turn.seat === state.players.filter((p) => p.alive).map((p) => p.id).at(-1)) {
    // best-effort phase-end alive list
  }
  log(`  · alive: [${alive.join(", ")}]`);
};

const t0 = Date.now();
let match;
try {
  match = await players.playMatch({ seed: SEED, n: N, nonce: NONCE, personas: PERSONAS, players: playerSeats, onTurn, onDiscussion });
} catch (err) {
  log(`\n**⚠️ match aborted:** ${err.message}\n`);
  throw err;
}
const mins = ((Date.now() - t0) / 60000).toFixed(1);
log(`\n---\n**Winner: ${match.winner} faction** · ${match.turns.length} attested moves · ${mins} min\n`);
console.log(`\nDONE — full log: ${LOG}`);
