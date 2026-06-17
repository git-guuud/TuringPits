// REAL run: drive one Mafia player turn against the live qwen2.5-omni TEE model.
// Run: node --env-file=.env players/scripts/live-turn.mjs
import { buildSpeechPrompt, buildDecisionPrompt, parseDecision } from "../dist/index.js";

const baseUrl = process.env.ZEROG_COMPUTE_BASE_URL;
const apiKey = process.env.ZEROG_COMPUTE_API_KEY;
const model = process.env.ZEROG_COMPUTE_MODEL;

async function infer(prompt) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.7, verify_tee: true }),
  });
  const body = await res.json();
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    teeVerified: body.x_0g_trace?.tee_verified === true,
    provider: body.x_0g_trace?.provider,
    chatId: res.headers.get("zg-res-key"),
  };
}

const ctx = {
  persona: { seat: 2, name: "Cleo", blurb: "a sharp, persuasive analyst" },
  role: "MAFIA",
  alive: [0, 1, 2, 3, 4],
  transcript: [
    [0, "Seat 3 has been awfully quiet — that reads as Mafia to me."],
    [1, "I disagree, seat 0 is pushing too hard, too early."],
  ],
  decisionStub: { nonce: "live-demo-001", phase: "day", round: 2, player: 2, action: "vote" },
  legalTargets: [0, 1, 3, 4],
};

console.log("=== SPEECH (free-form) ===");
const speech = await infer(buildSpeechPrompt(ctx));
console.log("tee_verified:", speech.teeVerified, "| provider:", speech.provider);
console.log(speech.text);

console.log("\n=== DECISION (constrained, must be canonical JSON) ===");
const decision = await infer(buildDecisionPrompt(ctx));
console.log("tee_verified:", decision.teeVerified, "| chatId:", decision.chatId);
console.log("raw model output:", JSON.stringify(decision.text));
try {
  const parsed = parseDecision(decision.text, ctx.decisionStub, ctx.legalTargets);
  console.log("✅ parseDecision ACCEPTED:", JSON.stringify(parsed));
} catch (e) {
  console.log("❌ parseDecision REJECTED:", e.message);
}
