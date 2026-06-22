// Guard-rejection diagnostic: reproduces the ROUND-1 reactor cascade (sparse transcript) that
// collapses most seats to passive fallbacks, and — with GUARD_DEBUG=1 — prints the RAW model
// output + the exact reason the moderator guard rejected it. Tells us whether rejections are
// name-fabrication, hallucination markers, or echo, which decides the prompt fix.
//   GUARD_DEBUG=1 node --env-file=.env players/scripts/guard-diag.mjs
import * as players from "@turingpits/players";

const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.TEE_PROVIDER_ADDRESS;
const RPC = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
if (!KEY || !PROVIDER_ADDR) throw new Error("need COMPUTE_PRIVATE_KEY + TEE_PROVIDER_ADDRESS in .env");

const ROSTER = [
  { seat: 0, name: "Ada", blurb: "a cold vote-counter; clipped, math-first, no warmth" },
  { seat: 1, name: "Boris", blurb: "a loud brawler; first to accuse, swings hard and fast" },
  { seat: 2, name: "Cleo", blurb: "a silver-tongued peacemaker who slows every rush to vote" },
  { seat: 3, name: "Dmitri", blurb: "a sardonic contrarian who distrusts the obvious read" },
  { seat: 4, name: "Esme", blurb: "a patient strategist who speaks rarely but lands hard" },
  { seat: 5, name: "Felix", blurb: "a blunt prosecutor who demands hard evidence for everything" },
  { seat: 6, name: "Greta", blurb: "a warm empath who reads tone and motive over logic" },
];
const alive = [1, 2, 3, 4, 5, 6]; // Ada (seat 0, the Detective) was killed night 1
// The exact vague round-1 opener from the baseline game that the rest of the table choked on.
const transcript = [[1, "Today, I need to hear from everyone who has spoken already. Who among us might be hiding a dark secret? Let’s see if we can spot any signs of deceit."]];

const base = (seat, role, extra = {}) => ({
  persona: ROSTER[seat], role, alive, roster: ROSTER, transcript,
  deaths: [{ round: 1, phase: "night", seat: 0 }],
  decisionStub: { nonce: "diag", phase: "day", round: 1, player: seat, action: "vote" },
  legalTargets: alive.filter((s) => s !== seat), stage: "discussion", ...extra,
});

const cases = [
  ["Cleo  (TOWN, reacts to Boris)", base(2, "TOWN")],
  ["Dmitri(MAFIA, reacts to Boris)", base(3, "MAFIA", { teammates: [4] })],
  ["Esme  (MAFIA, reacts to Boris)", base(4, "MAFIA", { teammates: [3] })],
  ["Felix (DOCTOR, reacts to Boris)", base(5, "DOCTOR")],
];

const provider = await players.createZeroGDirectProvider({ privateKey: KEY, rpcUrl: RPC, providerAddress: PROVIDER_ADDR });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let first = true;
for (const [label, ctx] of cases) {
  if (!first) await sleep(7000);
  first = false;
  let out = null;
  for (let a = 0; a < 3 && out === null; a++) {
    try { out = await new players.Player(provider).discuss(ctx); }
    catch (e) { console.warn(`  [retry] ${label}: ${e.message}`); await sleep(8000); }
  }
  console.log(`\n=== ${label} ===\n  FINAL: ${out?.speech}`);
}
