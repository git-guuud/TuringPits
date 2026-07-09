// FLUID-PROMPT verification on MAINNET: exercises the REAL builders (buildDiscussionPrompt /
// buildVoteSpeechPrompt) after the fluidity rework and runs each output through the REAL (now
// loosened) guard (hasBadMarker). Confirms the open prompts produce diverse, grounded, in-character
// play with no hallucination/CJK regressions, and that the loosened guard no longer nukes legit
// "silence/evasive" rhetoric. ~7 live calls.
//
//   node --env-file=.env players/scripts/fluid-verify.mjs
import * as players from "@turingpits/players";

const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.COMPUTE_PROVIDER_ADDRESS ?? process.env.TEE_PROVIDER_ADDRESS;
const RPC = process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const CHAIN_ID = process.env.COMPUTE_CHAIN_ID ? Number(process.env.COMPUTE_CHAIN_ID) : undefined;
if (!KEY || !PROVIDER_ADDR) throw new Error("need COMPUTE_PRIVATE_KEY + COMPUTE_PROVIDER_ADDRESS in .env");

const ROSTER = [
  { seat: 0, name: "Atlas", blurb: "loud and certain; drops short, final verdicts and dares you to argue back" },
  { seat: 1, name: "Vesper", blurb: "dry and cutting; needles people with quiet, loaded questions that catch them out" },
  { seat: 2, name: "Nova", blurb: "openly earnest; pleads, hopes out loud, and takes every betrayal to heart" },
  { seat: 3, name: "Kestrel", blurb: "restless and quick; fires short, clipped jabs and never sits still" },
  { seat: 4, name: "Mira", blurb: "calm and even-handed; weighs both sides out loud, then comes down hard" },
  { seat: 5, name: "Juno", blurb: "steady and plain-spoken; slow to anger, hard to rattle, immovable once decided" },
];
const alive = [0, 1, 2, 3, 4, 5];
const deaths = [{ round: 1, phase: "night", seat: 0 }]; // Atlas died in the night
const NONCE = "fluidverify";

// A round-2 day transcript with real suspicion on Kestrel (seat 3) so reactor scenarios have grip.
const transcript = [
  [1, "I have no hard read yet, but Kestrel keeps changing the subject every time the vote comes up."],
  [2, "Kestrel, that dodge worries me too — just answer Vesper straight."],
];

function ctx({ seat, role, round = 2, teammates, investigations }) {
  return {
    persona: ROSTER[seat],
    role,
    alive,
    roster: ROSTER,
    transcript,
    deaths,
    ...(teammates ? { teammates } : {}),
    ...(investigations ? { investigations } : {}),
    decisionStub: { nonce: NONCE, phase: "day", round, player: seat, action: "vote" },
    legalTargets: alive.filter((s) => s !== seat),
    stage: "discussion",
  };
}

const scenarios = [
  { label: "1 TOWN reactor (Nova, seat 2)", build: () => players.buildDiscussionPrompt(ctx({ seat: 2, role: "TOWN" })) },
  { label: "2 TOWN reactor (Kestrel, seat 3 — different seat → different stance nudge)", build: () => players.buildDiscussionPrompt(ctx({ seat: 3, role: "TOWN" })) },
  { label: "3 TOWN first speaker (empty transcript)", build: () => players.buildDiscussionPrompt({ ...ctx({ seat: 1, role: "TOWN", round: 1 }), transcript: [], deaths: [] }) },
  { label: "4 MAFIA reactor (Mira, seat 4, ally Nova=2) — open bluff permission", build: () => players.buildDiscussionPrompt(ctx({ seat: 4, role: "MAFIA", teammates: [2] })) },
  { label: "5 DETECTIVE caught a Mafia (investigated Kestrel=3=MAFIA) — de-scripted reveal", build: () => players.buildDiscussionPrompt(ctx({ seat: 5, role: "DETECTIVE", investigations: [{ round: 1, target: 3, faction: "MAFIA" }] })) },
  { label: "6 DETECTIVE cleared-Town (investigated Kestrel=3=TOWN) — vouch guard holds", build: () => players.buildDiscussionPrompt(ctx({ seat: 5, role: "DETECTIVE", investigations: [{ round: 1, target: 3, faction: "TOWN" }] })) },
  { label: "7 TOWN vote speech (merged TARGET/CASE)", build: () => players.buildVoteSpeechPrompt(ctx({ seat: 1, role: "TOWN" })) },
];

const provider = await players.createZeroGDirectProvider({
  privateKey: KEY, rpcUrl: RPC, providerAddress: PROVIDER_ADDR, ...(CHAIN_ID ? { chainId: CHAIN_ID } : {}),
});
console.log(`Provider up. rpc=${RPC} chainId=${CHAIN_ID ?? "(default)"} teeSigner=${provider.teeSignerAddress}\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outputs = [];
let bad = 0;
let first = true;
for (const { label, build } of scenarios) {
  if (!first) await sleep(7000);
  first = false;
  let text = null;
  for (let attempt = 0; attempt < 3 && text === null; attempt++) {
    try {
      ({ text } = await provider.complete(build(), { temperature: 0.8 }));
    } catch (err) {
      if (/429|rate limit/i.test(err.message) && attempt < 2) { await sleep(35000); continue; }
      console.log(`=== ${label} ⚠️ failed: ${err.message} ===\n`);
      break;
    }
  }
  if (text === null) continue;
  const t = text.trim();
  // NOTE: hasBadMarker is the BLUNT whole-text check. The real day pipeline (cleanDaySpeech) is more
  // permissive — it tests per-sentence WITH the own-night-claim exemption (a Detective may say "I
  // investigated X last night") and SALVAGES by dropping only the one bad sentence. So a flag here is
  // an UPPER BOUND: it may still be accepted (own-night reveal) or salvaged (one physical-tell sentence).
  const flagged = players.hasBadMarker(t);
  if (flagged) bad++;
  outputs.push({ label, t });
  console.log(`=== ${label} ${flagged ? "❌ GUARD-FLAG" : "✅ clean"} ===\n${t}\n`);
}

console.log("=".repeat(70));
console.log(`Guard-flagged: ${bad}/${outputs.length} (expect 0 — the loosened guard shouldn't nuke legit debate).`);
if (outputs.length >= 2) {
  const norm = (s) => new Set(s.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean));
  const a = norm(outputs[0].t), b = norm(outputs[1].t);
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  const jac = inter / (a.size + b.size - inter);
  console.log(`Cross-seat divergence (scenario 1 vs 2 word-overlap Jaccard): ${jac.toFixed(3)} (lower = more diverse).`);
}
