// DIVERSITY probe: does the MAINNET 0G model actually honor sampling, or is it "effectively
// greedy" like the old testnet qwen2.5-omni? This is the load-bearing fact for whether we can
// drop the deterministic divergence scaffolding (discussionAngle / displayOrder shuffle /
// prescriptive voiceDirective) in favour of much more fluid, open prompts.
//
// Method — isolate SAMPLING as the only variable: hold ONE open/fluid day-discussion prompt
// completely fixed (same seat, same persona, same transcript, NO forced angle/template) and call
// it repeatedly, varying ONLY the seed. If the outputs diverge, sampling works and open prompts
// will give diverse play. If they come back near-identical, the model is greedy and the
// deterministic per-seat variety engine is still load-bearing.
//
//   node --env-file=.env players/scripts/diversity-probe.mjs
import * as players from "@turingpits/players";

// MAINNET compute vars (mirrors server buildProvider's live branch). Falls back to testnet names
// only if the COMPUTE_* set is absent, so this hits whatever .env is currently pointed at.
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.COMPUTE_PROVIDER_ADDRESS ?? process.env.TEE_PROVIDER_ADDRESS;
const RPC = process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const CHAIN_ID = process.env.COMPUTE_CHAIN_ID ? Number(process.env.COMPUTE_CHAIN_ID) : undefined;
if (!KEY || !PROVIDER_ADDR) throw new Error("need COMPUTE_PRIVATE_KEY + COMPUTE_PROVIDER_ADDRESS in .env");

// A deliberately OPEN, un-scaffolded day-discussion prompt: this is the "fluid" target state — it
// carries the game-integrity grounding (no night-invention, silence≠guilt, present tense, English)
// but drops the prescriptive rhetorical-angle command that the current buildDiscussionPrompt ends
// on. So a low divergence here means the MODEL collapses, not that a rigid template forced it to.
const OPEN_PROMPT = [
  "You are playing the social-deduction game Mafia as Cleo (a peacemaker who hates rushing a vote), in seat 2.",
  "HOW MAFIA WORKS: a hidden-role game where a secret Mafia faction hides among the Town. At night the Mafia secretly remove one player; by day the town argues and votes one player out. The Town wins when every Mafia is gone; the Mafia win once they equal or outnumber the Town.",
  "You are TOWN — no powers, just your gut and your voice. The Town wins when every Mafia is gone.",
  "Players still in the game: Ada, Boris, Cleo (you), Dmitri, Esme, Felix. Refer to people by NAME, never \"seat N\".",
  "GROUNDING: the only facts you have are the recorded deaths and the transcript below. No one saw the night, so never describe what anyone did in the night and never read body language, tone, or nerves. A player who has not spoken yet is just waiting their turn — never call them quiet or suspicious for that. If you have no read on someone, say so rather than inventing one. Write your entire reply in English.",
  "This is live theatre — play to win AND to be watched. Take a real position; never fence-sit.",
  "",
  "It is the DAY phase of round 1. The town talks openly, then holds today's vote to remove one player.",
  "WHAT HAS HAPPENED (the ONLY facts about the night): round 1: Ada was killed by the Mafia during the previous night (killer unknown).",
  "Public discussion so far:",
  "  Boris: I have no read on anyone yet. Let's watch who pushes hardest in today's vote.",
  "",
  "Now speak, in 2–4 vivid sentences (under 70 words): react to what has been said and push today's debate forward in your own voice. Speak in the present (\"today\", not \"tonight\").",
].join("\n");

// Bad markers a day turn should never produce: night-confusion / silence-trope, OR any CJK char
// (the whole ENGLISH_ONLY question — do the new Chinese-trained models still code-switch?).
const BAD = /\btonight\b|\blast night\b|\bsilen(t|ce)\b|night behavio|[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/i;

const TEMP = 0.8; // the temperature player.ts sends live (SPEECH_TEMPERATURE)

// --- text-divergence metrics -------------------------------------------------------------------
const norm = (t) => t.trim().replace(/\s+/g, " ").toLowerCase();
const toks = (t) => new Set(norm(t).split(/[^a-z0-9']+/).filter(Boolean));
function jaccard(a, b) {
  const A = toks(a), B = toks(b);
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 1 : inter / uni;
}
function pairwiseMeanJaccard(texts) {
  const vals = [];
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) vals.push(jaccard(texts[i], texts[j]));
  if (vals.length === 0) return { mean: 1, min: 1, max: 1 };
  return {
    mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    min: Math.min(...vals),
    max: Math.max(...vals),
  };
}

const provider = await players.createZeroGDirectProvider({
  privateKey: KEY,
  rpcUrl: RPC,
  providerAddress: PROVIDER_ADDR,
  ...(CHAIN_ID ? { chainId: CHAIN_ID } : {}),
});
console.log(`Provider up. rpc=${RPC} chainId=${CHAIN_ID ?? "(default)"} teeSigner=${provider.teeSignerAddress}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(opts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { text } = await provider.complete(OPEN_PROMPT, opts);
      return text.trim();
    } catch (err) {
      if (/429|rate limit/i.test(err.message) && attempt < 2) { await sleep(35000); continue; }
      throw err;
    }
  }
}

// Test A — VARIED seeds at temp 0.8: the core divergence test.
// Test B — FIXED seed at temp 0.8, twice: seed-reproducibility control.
const runs = [
  ...[11, 22, 33, 44, 55, 66].map((seed) => ({ group: "A", label: `A seed=${seed}`, opts: { temperature: TEMP, seed } })),
  ...[777, 777].map((seed, i) => ({ group: "B", label: `B seed=${seed} #${i + 1}`, opts: { temperature: TEMP, seed } })),
];

const out = { A: [], B: [] };
let first = true;
for (const { group, label, opts } of runs) {
  if (!first) await sleep(7000); // provider enforces ~10 req/min
  first = false;
  let text;
  try {
    text = await call(opts);
  } catch (err) {
    console.log(`\n=== ${label} ⚠️ failed: ${err.message} ===`);
    continue;
  }
  out[group].push(text);
  const flagged = BAD.test(text);
  console.log(`\n=== ${label} ${flagged ? "❌ BAD-MARKER" : "✅ clean"} (${toks(text).size} tokens) ===\n${text}`);
}

// --- verdict -----------------------------------------------------------------------------------
const uniqA = new Set(out.A.map(norm)).size;
const jA = pairwiseMeanJaccard(out.A);
const bIdentical = out.B.length === 2 && norm(out.B[0]) === norm(out.B[1]);

console.log(`\n${"=".repeat(70)}\nDIVERSITY VERDICT`);
console.log(`Test A (varied seeds, temp ${TEMP}): ${out.A.length} calls, ${uniqA} exactly-distinct outputs.`);
console.log(`  mean pairwise word-overlap (Jaccard): ${jA.mean.toFixed(3)}  [min ${jA.min.toFixed(3)}, max ${jA.max.toFixed(3)}]`);
console.log(`  (1.000 = identical wording → GREEDY;  < ~0.5 = genuinely diverse phrasing)`);
console.log(`Test B (same seed x2): outputs ${bIdentical ? "IDENTICAL → seed is honored (reproducible)" : "DIFFER → server samples nondeterministically (seed not pinned)"}`);
const verdict =
  uniqA <= 1 || jA.mean > 0.85
    ? "GREEDY / sampling ignored → KEEP the deterministic divergence engine; open prompts alone will NOT diversify seats."
    : jA.mean < 0.55
    ? "SAMPLING WORKS → safe to drop discussionAngle / displayOrder shuffle / prescriptive voice and go fluid."
    : "PARTIAL divergence → sampling contributes but weakly; loosen the fill-in-the-template crutches, keep a lighter divergence nudge.";
console.log(`\n→ ${verdict}`);
