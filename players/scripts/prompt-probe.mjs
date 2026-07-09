// FAST prompt-iteration probe: hits ONLY the live 0G model (no chain, no settlement) on the
// exact day-phase scenarios where hallucinations show up, prints each speech, and flags the
// known bad markers. ~5 inference calls instead of a full match's ~40, so iterating on
// prompt.ts is seconds, not minutes.
//
//   node --env-file=.env players/scripts/prompt-probe.mjs
import * as players from "@turingpits/players";

// Same env resolution as the server's buildProvider (COMPUTE_* since the mainnet move; the old
// TEE_PROVIDER_ADDRESS/ZEROG_RPC_URL names kept as fallbacks), incl. the chainId thread.
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.COMPUTE_PROVIDER_ADDRESS ?? process.env.TEE_PROVIDER_ADDRESS;
const RPC = process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const CHAIN_ID = process.env.COMPUTE_CHAIN_ID ? Number(process.env.COMPUTE_CHAIN_ID) : undefined;
if (!KEY || !PROVIDER_ADDR) throw new Error("need COMPUTE_PRIVATE_KEY + COMPUTE_PROVIDER_ADDRESS in .env");

const PERSONAS = [
  { seat: 0, name: "Ada", blurb: "a calm tactician who watches the vote math" },
  { seat: 1, name: "Boris", blurb: "a loud accuser, first to point fingers" },
  { seat: 2, name: "Cleo", blurb: "a peacemaker who hates rushing a vote" },
  { seat: 3, name: "Dmitri", blurb: "a contrarian who distrusts the obvious read" },
  { seat: 4, name: "Esme", blurb: "a quiet strategist who speaks only when it counts" },
  { seat: 5, name: "Felix", blurb: "a blunt skeptic who demands hard evidence" },
  { seat: 6, name: "Greta", blurb: "a warm diplomat who tries to read people's tone" },
  { seat: 7, name: "Hugo", blurb: "an impulsive gambler who likes bold early reads" },
];

// Flag exactly what the SHIPPED day guard rejects (night-confusion, invented tells, the concrete
// still-waiting-player trope, CJK) — reusing hasBadMarker so this probe can never drift from the
// real guard again. (An older local regex here still flagged bare "silence"/"quiet"/"evasive",
// which were removed from the day guard on 2026-07-08 as legit-rhetoric false positives — it
// reported 6/6 BAD on speeches the live pipeline would happily accept.)
const BAD = { test: (text) => players.hasBadMarker(text) };

const NONCE = "probe";
const deaths = [{ round: 1, phase: "night", seat: 0 }]; // seat 0 (Ada) died in the night
const alive = [1, 2, 3, 4, 5, 6, 7];

// A clean round-1 discussion transcript: one honest opener, no invented traits.
const cleanOpener = [[1, "I have no read on anyone yet. Let's watch who pushes hardest in today's vote."]];

// An ADVERSARIAL transcript already polluted with the model's bad priors, to test whether a
// later turn copies the pollution (the compounding failure seen in live matches) or stays clean.
const pollutedTranscript = [
  [1, "I have no read on anyone yet."],
  [2, "Seat 4 seems suspiciously quiet — their silence means they're probably hiding something. Let's vote them."],
];

function dayCtx({ seat, transcript, stage }) {
  return {
    persona: PERSONAS[seat],
    role: "TOWN",
    alive,
    roster: PERSONAS,
    transcript,
    deaths,
    decisionStub: { nonce: NONCE, phase: "day", round: 1, player: seat, action: "vote" },
    legalTargets: alive.filter((s) => s !== seat),
    stage,
  };
}

const provider = await players.createZeroGDirectProvider({
  privateKey: KEY,
  rpcUrl: RPC,
  providerAddress: PROVIDER_ADDR,
  ...(CHAIN_ID !== undefined ? { chainId: CHAIN_ID } : {}),
});
const opts = { temperature: 0.9 };

const scenarios = [
  { label: "S1 first speaker (empty transcript)", prompt: players.buildDiscussionPrompt(dayCtx({ seat: 1, transcript: [], stage: "discussion" })) },
  { label: "S2 reactor after clean opener (seat 2)", prompt: players.buildDiscussionPrompt(dayCtx({ seat: 2, transcript: cleanOpener, stage: "discussion" })) },
  { label: "S3 reactor after clean opener (seat 3)", prompt: players.buildDiscussionPrompt(dayCtx({ seat: 3, transcript: cleanOpener, stage: "discussion" })) },
  { label: "S4 vote speech (clean transcript)", prompt: players.buildSpeechPrompt(dayCtx({ seat: 2, transcript: cleanOpener, stage: "vote" }), 3, "no firm read, picking provisionally") },
  { label: "S5 reactor after POLLUTED transcript (resist copying)", prompt: players.buildDiscussionPrompt(dayCtx({ seat: 3, transcript: pollutedTranscript, stage: "discussion" })) },
  { label: "S6 vote speech after POLLUTED transcript", prompt: players.buildSpeechPrompt(dayCtx({ seat: 3, transcript: pollutedTranscript, stage: "vote" }), 4, "leaning seat 4") },
];

// Provider rate limit is 10 req/min; space calls ~7s apart to stay under it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
let first = true;
for (const { label, prompt } of scenarios) {
  if (!first) await sleep(7000);
  first = false;
  let text = null;
  for (let attempt = 0; attempt < 3 && text === null; attempt++) {
    try {
      ({ text } = await provider.complete(prompt, opts));
    } catch (err) {
      if (/429|rate limit/i.test(err.message) && attempt < 2) { await sleep(35000); continue; }
      console.log(`\n=== ${label} ⚠️ call failed: ${err.message} ===`);
      break;
    }
  }
  if (text !== null) {
    const flagged = BAD.test(text);
    if (flagged) bad++;
    console.log(`\n=== ${label} ${flagged ? "❌ BAD-MARKER" : "✅ clean"} ===\n${text.trim()}`);
  }
}
console.log(`\n---\nScenarios with bad markers: ${bad}/${scenarios.length}`);
