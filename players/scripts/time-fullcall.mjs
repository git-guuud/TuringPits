// Time EACH sub-step of the server's real per-call path (ZeroGDirectProvider.completeOnce) on mainnet,
// to find which mainnet round-trip is the stall: getRequestHeaders / chat fetch / processResponse /
// signature-link / signature fetch. Runs 3 iterations. Mirrors players/src/zerog.ts completeOnce.
import { JsonRpcProvider, Wallet } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
import { buildInferenceRequestBody } from "/home/maury/TuringPits/players/dist/zerog.js";

const RPC = process.env.COMPUTE_RPC_URL, CHAIN_ID = Number(process.env.COMPUTE_CHAIN_ID);
const PROVIDER = process.env.COMPUTE_PROVIDER_ADDRESS;
const ms = (t) => `${((performance.now() - t) / 1000).toFixed(2)}s`;

let t = performance.now();
const wallet = new Wallet(process.env.COMPUTE_PRIVATE_KEY, new JsonRpcProvider(RPC, CHAIN_ID));
const broker = await createZGComputeNetworkBroker(wallet);
console.log("broker init:", ms(t));
const { endpoint, model } = await broker.inference.getServiceMetadata(PROVIDER);

const prompt = "You are Seat 3 in a game of Mafia on day 1. In two short sentences, accuse someone and "
  + "defend yourself. Players: Seat1..Seat6.";

for (let i = 1; i <= 3; i++) {
  console.log(`\n──── call ${i} ────`);
  let s = performance.now();
  const headers = await broker.inference.getRequestHeaders(PROVIDER, prompt);
  console.log("  getRequestHeaders :", ms(s));

  s = performance.now();
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(buildInferenceRequestBody(model, prompt, { seed: i })),
  });
  const rawBodyStr = await res.text();
  console.log("  chat fetch        :", ms(s), `(HTTP ${res.status})`);
  const chatId = res.headers.get("zg-res-key");
  const body = JSON.parse(rawBodyStr);

  s = performance.now();
  await broker.inference.processResponse(PROVIDER, chatId, JSON.stringify(body.usage ?? {}));
  console.log("  processResponse   :", ms(s), "  <-- TEE verify + fee settlement");

  s = performance.now();
  const link = await broker.inference.getChatSignatureDownloadLink(PROVIDER, chatId);
  console.log("  sig link          :", ms(s));

  s = performance.now();
  const sigRes = await fetch(link, { headers });
  await sigRes.json();
  console.log("  sig fetch         :", ms(s), `(HTTP ${sigRes.status})`);
}
process.exit(0);
