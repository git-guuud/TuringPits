// PATH B confirmation: Direct SDK → fetch a REAL TEE {text, signature} and ecrecover it.
// This proves the raw-signature path our on-chain verifier needs.
// Run: node --env-file=.env players/scripts/live-direct.mjs
import { createHash } from "node:crypto";
import { JsonRpcProvider, Wallet, verifyMessage } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

const RPC = "https://evmrpc-testnet.0g.ai"; // EVM RPC (NOT pc.testnet.0g.ai, which is the portal)
const KEY = process.env.COMPUTE_PRIVATE_KEY;
const PROVIDER = process.env.TEE_PROVIDER_ADDRESS; // 0xa48f…7836 (qwen2.5-omni)

const step = (n, s) => console.log(`\n=== ${n}. ${s} ===`);
const wallet = new Wallet(KEY, new JsonRpcProvider(RPC, 16602));
console.log("wallet:", wallet.address, "| provider:", PROVIDER);

step(1, "create broker");
const broker = await createZGComputeNetworkBroker(wallet);
console.log("broker ready");

step(2, "ledger (create/fund if needed)");
try {
  const l = await broker.ledger.getLedger();
  console.log("existing ledger:", JSON.stringify(l, (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 300));
} catch (e) {
  console.log("no ledger yet:", e.message?.slice(0, 120), "→ addLedger(3)");
  await broker.ledger.addLedger(3); // SDK-enforced 3 0G minimum
  console.log("ledger created");
}

step(3, "provider TEE signer status");
const status = await broker.inference.checkProviderSignerStatus(PROVIDER);
console.log("isAcknowledged:", status.isAcknowledged, "| teeSignerAddress:", status.teeSignerAddress);

step(4, "acknowledge provider signer (idempotent)");
try {
  await broker.inference.acknowledgeProviderSigner(PROVIDER);
  console.log("acknowledged");
} catch (e) {
  console.log("ack skipped/failed:", e.message?.slice(0, 160));
}

step(5, "service metadata");
const { endpoint, model } = await broker.inference.getServiceMetadata(PROVIDER);
console.log("endpoint:", endpoint, "| model:", model);

step(6, "request headers + chat call");
const content = "Reply with the single word: ping";
const headers = await broker.inference.getRequestHeaders(PROVIDER, content);
const res = await fetch(`${endpoint}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
});
console.log("status:", res.status);
const chatId = res.headers.get("zg-res-key");
const rawAnswerBytes = await res.text(); // exact response bytes (for hash hypothesis)
const body = JSON.parse(rawAnswerBytes);
const answer = body.choices?.[0]?.message?.content;
console.log("chatId (ZG-Res-Key):", chatId, "| answer:", JSON.stringify(answer));

step(7, "processResponse (SDK TEE verification)");
const valid = await broker.inference.processResponse(PROVIDER, chatId, JSON.stringify(body.usage ?? {}));
console.log("processResponse valid:", valid);

step(8, "RAW signature → ecrecover (the on-chain path)");
const link = await broker.inference.getChatSignatureDownloadLink(PROVIDER, chatId);
const sigRes = await fetch(link, { headers });
const sigData = await sigRes.json();
console.log("FULL sig payload:", JSON.stringify(sigData, null, 2));

const text = sigData.text;
const signature = sigData.signature;
const recovered = verifyMessage(text, signature);
console.log("\nrecovered signer    :", recovered);
console.log("== teeSignerAddress? :", recovered.toLowerCase() === status.teeSignerAddress.toLowerCase());

// The signed `text` is an envelope, not the answer. Decode + test the hash hypothesis.
const parts = String(text).split(":");
console.log("\nenvelope parts:", parts.length, parts.map((p, i) => `[${i}] ${p.slice(0, 16)}${p.length > 16 ? "…" : ""}`));
const rawReqBody = JSON.stringify({ model, messages: [{ role: "user", content }] });
for (const [label, bytes] of [["rawResponse", rawAnswerBytes], ["rawReqBody", rawReqBody]]) {
  const sha = createHash("sha256").update(bytes).digest("hex");
  console.log(`  sha256(${label}) = ${sha.slice(0, 16)}…  matches part[0]? ${sha === parts[0]}  part[1]? ${sha === parts[1]}`);
}
console.log("\n=== done ===");
