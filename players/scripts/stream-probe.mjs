// STREAMING probe: does the 0G Direct-SDK inference endpoint honor `stream: true`, and does billing
// (processResponse) still settle for a streamed response? Gates the streaming-discussion feature.
// Run: node --env-file=.env players/scripts/stream-probe.mjs
import { JsonRpcProvider, Wallet } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

const RPC = process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const CHAIN = Number(process.env.COMPUTE_CHAIN_ID ?? process.env.ZEROG_CHAIN_ID ?? 16602);
const KEY = process.env.COMPUTE_PRIVATE_KEY;
const PROVIDER = process.env.COMPUTE_PROVIDER_ADDRESS ?? process.env.TEE_PROVIDER_ADDRESS;
if (!KEY || !PROVIDER) throw new Error("set COMPUTE_PRIVATE_KEY and COMPUTE_PROVIDER_ADDRESS/TEE_PROVIDER_ADDRESS");

const START = Date.now();
const step = (n, s) => console.log(`\n=== ${n}. ${s} === (+${((Date.now() - START) / 1000).toFixed(1)}s)`);
const wallet = new Wallet(KEY, new JsonRpcProvider(RPC, CHAIN));
console.log(`wallet: ${wallet.address} | provider: ${PROVIDER} | rpc: ${RPC} (chain ${CHAIN})`);

step(1, "broker + ledger + ack");
const broker = await createZGComputeNetworkBroker(wallet);
try { await broker.ledger.getLedger(); console.log("ledger: exists"); }
catch { await broker.ledger.addLedger(3); console.log("ledger: created (3 0G)"); }
const status = await broker.inference.checkProviderSignerStatus(PROVIDER);
if (!status.isAcknowledged) await broker.inference.acknowledgeProviderSigner(PROVIDER);
const { endpoint, model } = await broker.inference.getServiceMetadata(PROVIDER);
console.log(`endpoint: ${endpoint} | model: ${model} | teeSigner: ${status.teeSignerAddress}`);

step(2, "POST /chat/completions with stream:true");
const content = "List three unrelated fruits, one per line. Then say DONE.";
const headers = await broker.inference.getRequestHeaders(PROVIDER, content);
const reqBody = {
  model,
  messages: [{ role: "user", content }],
  stream: true,
  stream_options: { include_usage: true }, // ask for a final usage chunk (OpenAI-compatible)
};
const t0 = Date.now();
const res = await fetch(`${endpoint}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(reqBody),
});
const chatId = res.headers.get("zg-res-key");
const ctype = res.headers.get("content-type");
console.log(`status: ${res.status} | content-type: ${ctype} | zg-res-key: ${chatId}`);
if (!res.ok) { console.log("body:", (await res.text()).slice(0, 500)); process.exit(1); }

step(3, "read the SSE stream (accumulate deltas, capture usage)");
const isSSE = /event-stream/i.test(ctype ?? "");
let ttftMs = null, chunks = 0, text = "", usage = null, sawDone = false, roleSeen = false;
if (isSSE && res.body) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { sawDone = true; continue; }
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      chunks++;
      const delta = obj.choices?.[0]?.delta;
      if (delta?.role) roleSeen = true;
      if (delta?.content) { if (ttftMs === null) ttftMs = Date.now() - t0; text += delta.content; }
      if (obj.usage) usage = obj.usage;
    }
  }
} else {
  // Not SSE — the endpoint ignored stream:true and returned a single JSON body.
  const whole = await res.text();
  console.log("NON-STREAM fallback body (first 300):", whole.slice(0, 300));
  try { const b = JSON.parse(whole); text = b.choices?.[0]?.message?.content ?? ""; usage = b.usage ?? null; } catch {}
}
const totalMs = Date.now() - t0;
console.log(`SSE: ${isSSE} | chunks: ${chunks} | role-delta: ${roleSeen} | [DONE]: ${sawDone}`);
console.log(`TTFT: ${ttftMs}ms | total: ${totalMs}ms | text.len: ${text.length}`);
console.log(`usage present: ${usage !== null} → ${JSON.stringify(usage)}`);
console.log(`--- accumulated text ---\n${text}\n------------------------`);

step(4, "processResponse billing on the streamed response");
if (!chatId) {
  console.log("NO zg-res-key header → cannot settle billing for a stream (BLOCKER for streamed discussion).");
} else {
  try {
    const ok = await broker.inference.processResponse(PROVIDER, chatId, JSON.stringify(usage ?? {}));
    console.log(`processResponse valid: ${ok}`);
  } catch (e) {
    console.log(`processResponse THREW: ${e.message?.slice(0, 300)}`);
  }
}

step(5, "verdict");
const streamWorks = isSSE && chunks > 0 && text.length > 0;
console.log(`stream:true honored ......... ${streamWorks ? "YES" : "NO"}`);
console.log(`usage available for billing .. ${usage !== null ? "YES (final chunk)" : "NO (pass {} — non-streamed path already tolerates this)"}`);
console.log(`zg-res-key for processResponse ${chatId ? "YES" : "NO"}`);
console.log("\n=== done ===");
