// Divergence probe: same scenario, DIFFERENT personas — does the new voice directive actually make
// seats sound distinct, or do they still parrot one another? Hits ONLY the model (no chain).
//   node --env-file=.env players/scripts/voice-probe.mjs
import * as players from "@turingpits/players";

const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.TEE_PROVIDER_ADDRESS ?? process.env.COMPUTE_PROVIDER_ADDRESS;
const RPC = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
if (!KEY || !PROVIDER_ADDR) throw new Error("need COMPUTE_PRIVATE_KEY + TEE_PROVIDER_ADDRESS in .env");

// A spread of contrasting voices from the new pool, all reacting to the SAME opener.
const CAST = [
  { seat: 0, name: "Atlas", blurb: "loud and certain; blunt one-line verdicts, no hedging" },
  { seat: 1, name: "Vesper", blurb: "dry and wry; speaks in understatement and pointed questions" },
  { seat: 2, name: "Cassius", blurb: "formal and lawyerly; builds a case point by point" },
  { seat: 3, name: "Wren", blurb: "soft-spoken and steady; gentle, careful phrasing" },
  { seat: 4, name: "Pip", blurb: "chatty and breezy; light, a little joking, disarming" },
];
const alive = [0, 1, 2, 3, 4];
const opener = [[4, "I've got no read on anyone yet — let's watch who pushes hardest in today's vote."]];

function ctxFor(p) {
  return {
    persona: p, role: "TOWN", alive, roster: CAST, transcript: opener,
    deaths: [], decisionStub: { nonce: "voice", phase: "day", round: 1, player: p.seat, action: "vote" },
    legalTargets: alive.filter((s) => s !== p.seat), stage: "discussion",
  };
}

const provider = await players.createZeroGDirectProvider({ privateKey: KEY, rpcUrl: RPC, providerAddress: PROVIDER_ADDR });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let first = true;
for (const p of CAST.slice(0, 4)) {            // 4 reactors (Pip is the opener)
  if (!first) await sleep(7000);
  first = false;
  const prompt = players.buildDiscussionPrompt(ctxFor(p));
  let text = null;
  for (let a = 0; a < 3 && text === null; a++) {
    try { ({ text } = await provider.complete(prompt, { temperature: 0.8 })); }
    catch (e) { console.warn(`  [retry] ${p.name}: ${e.message}`); await sleep(7000); }
  }
  console.log(`\n${p.name} (${p.blurb}):\n  ${text}`);
}
