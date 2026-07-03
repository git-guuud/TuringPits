// FOCUSED live check for task 3 (Mafia fake-Detective bluff must FIRE).
// Reconstructs a round-2 day discussion where the Mafia (Cleo) has a credible non-teammate frame
// target (Dmitri, whom the table already suspects), then runs ONE live discuss() and inspects whether
// the weak model actually AUTHORS the structured lie ("I'm the Detective, I investigated Dmitri…").
// The open question (role-strategic-play memory): does the filled-template task overcome the model's
// refusal to invent a structured lie? Fast: 1–2 live calls, not a full match.
//
//   node --env-file=.env players/scripts/bluff-probe.mjs
import * as players from "@turingpits/players";

const RPC = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.TEE_PROVIDER_ADDRESS;
if (!KEY || !PROVIDER_ADDR) throw new Error("need COMPUTE_PRIVATE_KEY + TEE_PROVIDER_ADDRESS in .env");

const base = await players.createZeroGDirectProvider({ privateKey: KEY, rpcUrl: RPC, providerAddress: PROVIDER_ADDR });
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

// Round-2 day discussion. Cleo (seat 2) is MAFIA with ally Esme (seat 4). The table already suspects
// Dmitri (seat 3) — a credible, non-teammate frame target — so the bluff branch fires aimed at Dmitri.
const ctx = {
  persona: roster[2],
  role: "MAFIA",
  alive: [0, 1, 2, 3, 4, 5],
  roster,
  teammates: [4], // secret ally Esme — must NEVER be framed
  transcript: [
    [0, "Dmitri keeps dodging every question I put to him — he's my suspect today."],
    [1, "I'm with Ada — Dmitri talks in circles and never commits. I'd vote him."],
  ],
  decisionStub: { nonce: "bluff-probe", phase: "day", round: 2, player: 2, action: "vote" },
  legalTargets: [0, 1, 3, 4, 5],
  stage: "discussion",
  deaths: [{ round: 1, phase: "night", seat: 6 }],
};

console.log("Scenario: Cleo (MAFIA, ally=Esme) at round-2 discussion; table suspects Dmitri.\n");
const { speech } = await new players.Player(provider, { decisionRetries: 4 }).discuss(ctx);
console.log("\n==================== Cleo discussion line ====================");
console.log(speech);
console.log("==============================================================");
// Use the SAME exported detector the live match keys off to float the "real or bluff?" market (task 6.4),
// so this probe confirms the bluff both FIRES and would open the market — not a divergent local regex.
const claimed = players.claimsDetective(speech);
const framesDmitri = /\bDmitri\b/i.test(speech);
const namesAlly = /\bEsme\b/i.test(speech);
console.log(`\nClaims to be the Detective? ${claimed ? "✅ YES (bluff fired → market would open)" : "❌ NO (model would not author the lie)"}`);
console.log(`Frames a target named Dmitri?  ${framesDmitri ? "✅ YES" : "—"}`);
console.log(`Leaks/accuses ally Esme?       ${namesAlly ? "❌ YES (BAD)" : "✅ NO"}`);
