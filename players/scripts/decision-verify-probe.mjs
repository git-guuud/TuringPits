// Does enable_thinking:false keep the SIGNED decision call byte-exact? The decision prompt is a pure
// "copy this line exactly" transcription — reasoning can only make it DRIFT. Verify on mainnet across a
// few samples (byte-exact + parseable), and time it vs thinking-on. Non-stream, mirroring the real call.
// Run: COMPUTE_RPC_URL=https://evmrpc.0g.ai COMPUTE_CHAIN_ID=16661 \
//   COMPUTE_PROVIDER_ADDRESS=0x992e6396157Dc4f22E74F2231235D7DE62696db5 \
//   node --env-file=.env players/scripts/decision-verify-probe.mjs
import { JsonRpcProvider, Wallet } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
import { buildDecisionPrompt } from "/home/maury/TuringPits/players/dist/prompt.js";
import { parseDecision } from "/home/maury/TuringPits/players/dist/decision.js";
import { encodeDecision } from "@turingpits/engine";

const RPC = process.env.COMPUTE_RPC_URL ?? "https://evmrpc.0g.ai";
const CHAIN = Number(process.env.COMPUTE_CHAIN_ID ?? 16661);
const PROVIDER = process.env.COMPUTE_PROVIDER_ADDRESS ?? "0x992e6396157Dc4f22E74F2231235D7DE62696db5";
const wallet = new Wallet(process.env.COMPUTE_PRIVATE_KEY, new JsonRpcProvider(RPC, CHAIN));
const broker = await createZGComputeNetworkBroker(wallet);
try { await broker.ledger.getLedger(); } catch { await broker.ledger.addLedger(3); }
const st = await broker.inference.checkProviderSignerStatus(PROVIDER);
if (!st.isAcknowledged) await broker.inference.acknowledgeProviderSigner(PROVIDER);
const { endpoint, model } = await broker.inference.getServiceMetadata(PROVIDER);
console.log(`model: ${model}\n`);

const stub = { nonce: "match-verify", phase: "day", round: 2, player: 3, action: "vote" };
const target = 5;
const prompt = buildDecisionPrompt({ decisionStub: stub }, target);
const expected = encodeDecision({ ...stub, target });
console.log(`expected canonical: ${expected}\n`);

async function decide(label, extra) {
  const headers = await broker.inference.getRequestHeaders(PROVIDER, prompt);
  const body = { model, messages: [{ role: "user", content: prompt }], ...extra };
  const t0 = Date.now();
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const raw = await res.text();
  const ms = Date.now() - t0;
  if (!res.ok) { console.log(`${label}: HTTP ${res.status} ${raw.slice(0, 150)}`); return; }
  const text = JSON.parse(raw).choices?.[0]?.message?.content ?? "";
  const byteExact = text === expected;
  let parseOk = false;
  try { parseDecision(text, stub, [target]); parseOk = true; } catch {}
  console.log(`${label}: ${ms}ms | byte-exact ${byteExact} | parseDecision ${parseOk} | got ${JSON.stringify(text.slice(0, 90))}`);
}

// enable_thinking:false, sampled a few times (byte-exactness must be robust, not a one-off).
for (let i = 1; i <= 3; i++) await decide(`OFF #${i}`, { chat_template_kwargs: { enable_thinking: false } });
// One control with thinking on, to show the latency (and drift risk) it costs.
await decide("ON  (control)", {});
console.log("\n=== done ===");
