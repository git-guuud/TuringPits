// MOVEOVER.md STEP 0 — THE PROBE (go/no-go gate for moving inference to 0G mainnet).
//
// Runs ONE real inference against a chosen 0G *mainnet* Compute provider and proves the signed
// envelope has the EXACT shape our on-chain verifier reconstructs:
//     reqHash : resHash : providerType : providerIdentity : tlsFingerprint   (EIP-191 signed)
// If it does, the mainnet switch is an off-chain-only, env-only change (no contract redeploy) and
// this prints the mainnet `teeSigner` you register. If it DIFFERS, see MOVEOVER.md "If the
// envelope differs" (the hard path: update zerog.ts + TeeEnvelope.sol + redeploy the market).
//
// PREREQS (see myTasks.md):
//   • COMPUTE_PRIVATE_KEY's wallet holds REAL mainnet 0G (~4 0G; there is NO mainnet faucet).
//   • COMPUTE_PROVIDER_ADDRESS points at a TeeML mainnet provider (enumerate with:
//       COMPUTE_RPC_URL=https://evmrpc.0g.ai COMPUTE_CHAIN_ID=16661 \
//         node --env-file=.env players/scripts/list-models.mjs)
//
// Run:
//   COMPUTE_RPC_URL=https://evmrpc.0g.ai COMPUTE_CHAIN_ID=16661 \
//     COMPUTE_PROVIDER_ADDRESS=0x... node --env-file=.env players/scripts/live-direct-mainnet.mjs
import { createHash } from "node:crypto";
import { JsonRpcProvider, Wallet, verifyMessage, formatEther } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

const RPC = process.env.COMPUTE_RPC_URL ?? "https://evmrpc.0g.ai"; // 0G mainnet EVM RPC
const CHAIN_ID = Number(process.env.COMPUTE_CHAIN_ID ?? 16661); // 0G mainnet ("Aristotle")
const KEY = process.env.COMPUTE_PRIVATE_KEY;
const PROVIDER = process.env.COMPUTE_PROVIDER_ADDRESS; // the mainnet provider = the model choice
if (!KEY) throw new Error("set COMPUTE_PRIVATE_KEY (funded with REAL mainnet 0G)");
if (!PROVIDER) throw new Error("set COMPUTE_PROVIDER_ADDRESS to the chosen mainnet provider (see list-models.mjs)");

const step = (n, s) => console.log(`\n=== ${n}. ${s} ===`);
const wallet = new Wallet(KEY, new JsonRpcProvider(RPC, CHAIN_ID));
console.log(`network: ${RPC} (chainId ${CHAIN_ID})`);
console.log("wallet:", wallet.address, "| provider:", PROVIDER);

step(0, "wallet mainnet balance (need ~4 0G to fund the ledger)");
const bal = await wallet.provider.getBalance(wallet.address);
console.log("balance:", formatEther(bal), "0G");
if (bal === 0n) throw new Error(`wallet ${wallet.address} has 0 mainnet 0G — fund it first (no faucet; buy/bridge). See myTasks.md.`);

step(1, "create broker");
const broker = await createZGComputeNetworkBroker(wallet);
console.log("broker ready");

step(2, "ledger (create/fund if needed — SDK-enforced 3 0G minimum)");
try {
  const l = await broker.ledger.getLedger();
  console.log("existing ledger:", JSON.stringify(l, (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 300));
} catch (e) {
  console.log("no ledger yet:", e.message?.slice(0, 120), "→ addLedger(3)");
  await broker.ledger.addLedger(3);
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
const rawAnswerBytes = await res.text(); // exact response bytes (sha256 → envelope part[1])
if (!res.ok) throw new Error(`inference failed: ${res.status} ${rawAnswerBytes.slice(0, 300)}`);
const body = JSON.parse(rawAnswerBytes);
const answer = body.choices?.[0]?.message?.content;
console.log("chatId (ZG-Res-Key):", chatId, "| answer:", JSON.stringify(answer));

step(7, "processResponse (SDK TEE verification + fee settlement)");
const valid = await broker.inference.processResponse(PROVIDER, chatId, JSON.stringify(body.usage ?? {}));
console.log("processResponse valid:", valid);

step(8, "RAW signature → ecrecover (the on-chain settlement path)");
const link = await broker.inference.getChatSignatureDownloadLink(PROVIDER, chatId);
const sigRes = await fetch(link, { headers });
const sigData = await sigRes.json();
const envelope = sigData.text;
const signature = sigData.signature;
console.log("\nRAW ENVELOPE STRING:", JSON.stringify(envelope));
console.log("signature:", signature);

const recovered = verifyMessage(envelope, signature); // assumes EIP-191/personal_sign (our assumption)
const parts = String(envelope).split(":");
const shaResp = createHash("sha256").update(rawAnswerBytes).digest("hex");

console.log("\n──────── GO / NO-GO ────────");
const okParts = parts.length === 5;
const okResHash = parts[1] === shaResp;
const okSigner = recovered.toLowerCase() === status.teeSignerAddress.toLowerCase();
console.log(`[${okParts ? "✅" : "❌"}] envelope has exactly 5 colon-parts (got ${parts.length})`);
parts.forEach((p, i) => console.log(`        [${i}] ${p.slice(0, 24)}${p.length > 24 ? "…" : ""}`));
console.log(`[${okResHash ? "✅" : "❌"}] sha256(rawResponse) == part[1]  (envelope signs the RESPONSE body)`);
console.log(`[${okSigner ? "✅" : "❌"}] recovered signer == status.teeSignerAddress`);
console.log(`        recovered : ${recovered}`);
console.log(`        expected  : ${status.teeSignerAddress}`);

if (okParts && okResHash && okSigner) {
  console.log("\n✅ ENVELOPE MATCHES — off-chain/env-only switch (MOVEOVER Steps 1-3, no redeploy).");
  console.log("   Set in .env for the mainnet switch:");
  console.log(`     COMPUTE_RPC_URL=${RPC}`);
  console.log(`     COMPUTE_CHAIN_ID=${CHAIN_ID}`);
  console.log(`     COMPUTE_PROVIDER_ADDRESS=${PROVIDER}`);
  console.log(`   (teeSigner ${status.teeSignerAddress} is auto-registered from the probe — no env var needed.)`);
} else {
  console.log("\n❌ ENVELOPE DIFFERS — this is the hard path. See MOVEOVER.md 'If the envelope differs'");
  console.log("   (update zerog.ts + TeeEnvelope.sol + redeploy the Galileo market), or pick another");
  console.log("   TeeML provider whose envelope already matches.");
}
console.log("\n=== done ===");
