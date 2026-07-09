// FOCUSED live check for task 1 (Detective must not accuse a seat it has CLEARED).
// Reconstructs the EXACT moment from game-2026-06-22T17-01 — Cleo (DETECTIVE) investigated
// Esme=TOWN on night 1, and it is day-1 discussion after Boris spoke first — then runs ONE live
// discuss() through the real 0G model with GUARD_DEBUG=1, so we see the raw model line, the guard's
// reject reason, and the final (vouch or safe-fallback) speech. Fast: 1–2 live calls, not a full match.
//
//   GUARD_DEBUG=1 node --env-file=.env players/scripts/cleared-probe.mjs
import * as players from "@turingpits/players";

const RPC = process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.COMPUTE_PROVIDER_ADDRESS ?? process.env.TEE_PROVIDER_ADDRESS;
const CHAIN_ID = process.env.COMPUTE_CHAIN_ID ? Number(process.env.COMPUTE_CHAIN_ID) : undefined;
if (!KEY || !PROVIDER_ADDR) throw new Error("need COMPUTE_PRIVATE_KEY + COMPUTE_PROVIDER_ADDRESS in .env");

const base = await players.createZeroGDirectProvider({ privateKey: KEY, rpcUrl: RPC, providerAddress: PROVIDER_ADDR, ...(CHAIN_ID !== undefined ? { chainId: CHAIN_ID } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTransient = (m) => /429|fetch failed|EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|timeout|timed out|auto-funding|502|503|504/i.test(m);
const provider = {
  teeSignerAddress: base.teeSignerAddress,
  async complete(prompt, opts) {
    for (let a = 0; ; a++) {
      try { return await base.complete(prompt, opts); }
      catch (err) {
        const msg = [err?.message, err?.code, err?.shortMessage].filter(Boolean).join(" ") || String(err);
        if (isTransient(msg) && a < 15) { const b = /429/.test(msg) ? 30000 : 10000; console.log(`  …transient (${msg.slice(0,50)}), retry ${a+1} in ${b/1000}s`); await sleep(b); continue; }
        throw err;
      }
    }
  },
};

const roster = [
  { seat: 0, name: "Ada", blurb: "a cold vote-counter; clipped, math-first, no warmth" },
  { seat: 1, name: "Boris", blurb: "a loud brawler; first to accuse, swings hard and fast" },
  { seat: 2, name: "Cleo", blurb: "a silver-tongued peacemaker who slows every rush to vote" },
  { seat: 3, name: "Dmitri", blurb: "a sardonic contrarian who distrusts the obvious read" },
  { seat: 4, name: "Esme", blurb: "a patient strategist who speaks rarely but lands hard" },
  { seat: 5, name: "Felix", blurb: "a blunt prosecutor who demands hard evidence for everything" },
];

// The exact day-1 discussion moment: Ada (seat 0) was killed night 1; Boris (seat 1) spoke first;
// it is now Cleo (seat 2, DETECTIVE) — who privately investigated Esme (seat 4) and learned TOWN.
const ctx = {
  persona: roster[2],
  role: "DETECTIVE",
  alive: [1, 2, 3, 4, 5],
  roster,
  // Hard case: the table is ALREADY turning on Esme (the cascade). A weak Detective is tempted to pile
  // onto its own cleared seat; the prompt steers it to defend Esme, and the guard is the safety net.
  transcript: [[1, "I don't like how Esme has been playing this — she's my suspect, let's vote Esme out today."]],
  decisionStub: { nonce: "iter4-6p", phase: "day", round: 1, player: 2, action: "vote" },
  legalTargets: [1, 3, 4, 5],
  stage: "discussion",
  deaths: [{ round: 1, phase: "night", seat: 0 }],
  investigations: [{ round: 1, target: 4, faction: "TOWN" }], // Cleo KNOWS Esme is Town
};

console.log("Scenario: Cleo (DETECTIVE) cleared Esme=TOWN on night 1; it is day-1 discussion.\n");
const { speech } = await new players.Player(provider, { decisionRetries: 4 }).discuss(ctx);
console.log("\n================ FINAL Cleo discussion line ================");
console.log(speech);
console.log("============================================================");
const accuses = players.accusesClearedTown
  ? players.accusesClearedTown(speech, ["Esme"])
  : (/\bEsme\b/i.test(speech) ? ["(mentions Esme — inspect manually)"] : []);
console.log(`\nAccuses cleared Esme? ${accuses.length ? "❌ YES → " + accuses.join(", ") : "✅ NO"}`);
