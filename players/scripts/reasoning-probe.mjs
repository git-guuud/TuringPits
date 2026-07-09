// Can we DISABLE qwen3.6-plus's hidden reasoning for short discussion lines? Reasoning added ~10s TTFT
// + 471 wasted tokens in the stream probe. If a disable switch works, streaming discussion is fast &
// worth building; if not, streaming buys ~nothing on this model. Tries the two standard Qwen3 switches.
// Run: COMPUTE_RPC_URL=https://evmrpc.0g.ai COMPUTE_CHAIN_ID=16661 \
//   COMPUTE_PROVIDER_ADDRESS=0x992e6396157Dc4f22E74F2231235D7DE62696db5 \
//   node --env-file=.env players/scripts/reasoning-probe.mjs
import { JsonRpcProvider, Wallet } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

const RPC = process.env.COMPUTE_RPC_URL ?? "https://evmrpc.0g.ai";
const CHAIN = Number(process.env.COMPUTE_CHAIN_ID ?? 16661);
const PROVIDER = process.env.COMPUTE_PROVIDER_ADDRESS ?? "0x992e6396157Dc4f22E74F2231235D7DE62696db5";
const wallet = new Wallet(process.env.COMPUTE_PRIVATE_KEY, new JsonRpcProvider(RPC, CHAIN));
const broker = await createZGComputeNetworkBroker(wallet);
try { await broker.ledger.getLedger(); } catch { await broker.ledger.addLedger(3); }
const st = await broker.inference.checkProviderSignerStatus(PROVIDER);
if (!st.isAcknowledged) await broker.inference.acknowledgeProviderSigner(PROVIDER);
const { endpoint, model } = await broker.inference.getServiceMetadata(PROVIDER);
console.log(`model: ${model} | endpoint: ${endpoint}\n`);

// One streamed call; returns TTFT + reasoning-token count so we can see if thinking was suppressed.
async function call(label, content, extra) {
  const headers = await broker.inference.getRequestHeaders(PROVIDER, content);
  const body = { model, messages: [{ role: "user", content }], stream: true, stream_options: { include_usage: true }, ...extra };
  const t0 = Date.now();
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  if (!res.ok) { console.log(`${label}: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`); return; }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "", ttft = null, text = "", usage = null;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim(); if (p === "[DONE]") continue;
      let o; try { o = JSON.parse(p); } catch { continue; }
      if (o.choices?.[0]?.delta?.content) { if (ttft === null) ttft = Date.now() - t0; text += o.choices[0].delta.content; }
      if (o.usage) usage = o.usage;
    }
  }
  const r = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  console.log(`${label}\n  TTFT ${ttft}ms | total ${Date.now() - t0}ms | reasoning_tokens ${r} | text: ${JSON.stringify(text.slice(0, 80))}\n`);
}

const prompt = "You are a player in a game. In 2 sentences, cast suspicion on another player named Boris. Be dramatic.";
await call("A. baseline (reasoning ON)", prompt, {});
await call("B. /no_think prompt switch", prompt + " /no_think", {});
await call("C. chat_template_kwargs.enable_thinking=false", prompt, { chat_template_kwargs: { enable_thinking: false } });
console.log("=== done ===");
