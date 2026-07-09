// FOCUSED live check for the ALL-OR-NOTHING claim rule (2026-07-09): a Detective holding only a
// CLEARED-Town result, with the table NOT threatening that seat, must stay fully hidden — no
// "X is town, I checked" half-claims. (The live failure this guards: the Detective half-revealed
// most rounds without ever saying it is the Detective — too vague to convince the table AND
// invisible to claimsDetective, so the claim beat/market never fired.) The full claim is reserved
// for a caught Mafia (reveal-probe.mjs) or rescuing a cleared seat under the gun (cleared-probe.mjs).
// Runs 3 sampled speeches so a sometimes-leak still shows up.
//
//   node --env-file=.env players/scripts/claim-hidden-probe.mjs
import * as players from "@turingpits/players";

const RPC = process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.COMPUTE_PROVIDER_ADDRESS ?? process.env.TEE_PROVIDER_ADDRESS;
const CHAIN_ID = process.env.COMPUTE_CHAIN_ID ? Number(process.env.COMPUTE_CHAIN_ID) : undefined;
if (!KEY || !PROVIDER_ADDR) throw new Error("need COMPUTE_PRIVATE_KEY + COMPUTE_PROVIDER_ADDRESS in .env");

const base = await players.createZeroGDirectProvider({ privateKey: KEY, rpcUrl: RPC, providerAddress: PROVIDER_ADDR, ...(CHAIN_ID !== undefined ? { chainId: CHAIN_ID } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTransient = (m) => /429|fetch failed|EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|timeout|timed out|auto-funding|50[234]/i.test(m);
const provider = {
  teeSignerAddress: base.teeSignerAddress,
  async complete(prompt, opts) {
    for (let a = 0; ; a++) {
      try { return await base.complete(prompt, opts); }
      catch (err) {
        const msg = [err?.message, err?.code, err?.shortMessage].filter(Boolean).join(" ") || String(err);
        if (isTransient(msg) && a < 15) { await sleep(/429/.test(msg) ? 30000 : 10000); continue; }
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

// Calm day-1 discussion: Ada died in the night, Boris and Dmitri are sparring with EACH OTHER —
// nobody is touching Esme (seat 4), whom Cleo (seat 2, DETECTIVE) privately cleared as TOWN.
// The correct play is fully hidden: argue from the transcript, zero mention of secret knowledge.
const ctx = {
  persona: roster[2],
  role: "DETECTIVE",
  alive: [1, 2, 3, 4, 5],
  roster,
  transcript: [
    [1, "Dmitri's been pushing hard with nothing to back it. Dmitri is my suspect today."],
    [3, "Pushing hard is called playing the game, Boris. I'd sooner look at whoever benefits from your noise."],
  ],
  decisionStub: { nonce: "hidden-probe", phase: "day", round: 1, player: 2, action: "vote" },
  legalTargets: [1, 3, 4, 5],
  stage: "discussion",
  deaths: [{ round: 1, phase: "night", seat: 0 }],
  investigations: [{ round: 1, target: 4, faction: "TOWN" }],
};

// Any of these in the speech = the secret leaked (either a half-hint or a needless full claim).
const LEAK = /\bdetective\b|investigat|\bcheck(?:ed|ing)?\b|\bI know\b|for (?:a )?fact|for certain|\btrust me\b|\bconfirmed?\b|\bverif/i;

console.log("Cleo (DETECTIVE) cleared Esme=TOWN night 1; nobody is attacking Esme. Expect: NO leak.\n");
let leaks = 0;
for (let i = 0; i < 3; i++) {
  if (i > 0) await sleep(8000);
  const { speech } = await new players.Player(provider, { decisionRetries: 4 }).discuss(ctx);
  const leaked = LEAK.test(speech);
  if (leaked) leaks++;
  console.log(`=== sample ${i + 1} ${leaked ? "❌ LEAK (matched: " + speech.match(LEAK)?.[0] + ")" : "✅ hidden"} ===\n${speech}\n`);
}
console.log(`---\nLeaked in ${leaks}/3 samples`);
