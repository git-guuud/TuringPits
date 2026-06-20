// Probe whether the 0G Router returns a recoverable TEE signature (not just a boolean).
//   node --env-file=.env players/scripts/router-tee-probe.mjs [model]
import { JsonRpcProvider, Wallet, verifyMessage } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

const BASE = (process.env.ZEROG_COMPUTE_BASE_URL ?? "https://router-api.0g.ai/v1").replace(/\/$/, "");
const KEY = process.env.ZEROG_COMPUTE_API_KEY;
const RPC = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const WALLET_KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const MODEL = process.argv[2] ?? "0gm-1.0-35b-a3b";
if (!KEY) throw new Error("need ZEROG_COMPUTE_API_KEY in .env");

console.log(`Router: ${BASE}   model: ${MODEL}\n`);

const res = await fetch(`${BASE}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: "Reply with the single word: ping" }],
    max_tokens: 16,
    verify_tee: true,
  }),
});
const raw = await res.text();
console.log(`HTTP ${res.status}`);
const interesting = ["zg-res-key", "zg-provider", "x-0g-provider", "x-provider"];
for (const [k, v] of res.headers.entries()) if (interesting.includes(k.toLowerCase())) console.log(`header ${k}: ${v}`);
if (!res.ok) { console.log(raw.slice(0, 600)); process.exit(1); }

const body = JSON.parse(raw);
console.log(`\ncontent: ${JSON.stringify(body.choices?.[0]?.message?.content)}`);
console.log(`x_0g_trace: ${JSON.stringify(body.x_0g_trace ?? body.x0gTrace ?? "(none)", null, 2)}`);

const chatId = res.headers.get("zg-res-key");
const providerAddr = body.x_0g_trace?.provider ?? body.x_0g_trace?.provider_address;
console.log(`\nchatId(ZG-Res-Key): ${chatId}   provider: ${providerAddr}`);

// Resolve the provider's on-chain url + teeSignerAddress, then fetch + verify the signature.
if (providerAddr && WALLET_KEY) {
  try {
    const broker = await createZGComputeNetworkBroker(new Wallet(WALLET_KEY, new JsonRpcProvider(RPC, 16602)));
    let svc;
    try { svc = await broker.inference.getService?.(providerAddr); } catch { /* fall back to list */ }
    if (!svc) {
      const all = await broker.inference.listService();
      svc = all.find((s) => s.provider.toLowerCase() === providerAddr.toLowerCase());
    }
    console.log(`on-chain service for provider: ${svc ? `url=${svc.url} signer=${svc.teeSignerAddress}` : "NOT REGISTERED on testnet 16602"}`);
    if (svc && chatId) {
      const url = `${svc.url.replace(/\/$/, "")}/v1/proxy/signature/${chatId}?model=${encodeURIComponent(MODEL)}`;
      const sigRes = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
      console.log(`signature endpoint ${url} -> HTTP ${sigRes.status}`);
      if (sigRes.ok) {
        const { text, signature } = await sigRes.json();
        console.log(`envelope: ${text}`);
        console.log(`signature: ${signature}`);
        const recovered = verifyMessage(text, signature);
        console.log(`recovered signer: ${recovered}`);
        console.log(recovered.toLowerCase() === svc.teeSignerAddress.toLowerCase()
          ? "✅ signature RECOVERS to the provider's on-chain teeSignerAddress — usable for our settlement"
          : "❌ recovered signer does NOT match on-chain teeSignerAddress");
      } else {
        console.log((await sigRes.text()).slice(0, 300));
      }
    }
  } catch (e) {
    console.log(`chain/signature step failed: ${e.message}`);
  }
}
