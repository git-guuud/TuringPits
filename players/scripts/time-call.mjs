// Time ONE real inference call against the live mainnet provider the server is using — measures pure
// endpoint latency, HTTP status (200 vs 429), and completion_tokens (confirms reasoning on/off).
// Replicates the server's exact request body (buildInferenceRequestBody, enable_thinking:false).
import { JsonRpcProvider, Wallet } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
import { buildInferenceRequestBody } from "/home/maury/TuringPits/players/dist/zerog.js";

const RPC = process.env.COMPUTE_RPC_URL, CHAIN_ID = Number(process.env.COMPUTE_CHAIN_ID);
const PROVIDER = process.env.COMPUTE_PROVIDER_ADDRESS;
const wallet = new Wallet(process.env.COMPUTE_PRIVATE_KEY, new JsonRpcProvider(RPC, CHAIN_ID));
const broker = await createZGComputeNetworkBroker(wallet);
const { endpoint, model } = await broker.inference.getServiceMetadata(PROVIDER);

// A representative day-turn-sized prompt so latency/token counts resemble a real turn.
const prompt = "You are Seat 3 in a game of Mafia. It is day 1. Players: Seat1..Seat6. No one has died. "
  + "In 2 short sentences, cast suspicion on one player and defend yourself. Stay in character.";
const body = buildInferenceRequestBody(model, prompt, { seed: 42 });
console.log("request body keys:", JSON.stringify(body).slice(0, 200));
console.log("endpoint:", endpoint, "| model:", model);

const headers = await broker.inference.getRequestHeaders(PROVIDER, prompt);
const t = Date.now();
const res = await fetch(`${endpoint}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const raw = await res.text();
const ms = Date.now() - t;
console.log(`\nHTTP ${res.status}  in  ${(ms / 1000).toFixed(2)}s`);
try {
  const j = JSON.parse(raw);
  console.log("usage:", JSON.stringify(j.usage));
  console.log("answer:", JSON.stringify(j.choices?.[0]?.message?.content ?? "").slice(0, 240));
} catch { console.log("body:", raw.slice(0, 400)); }
process.exit(0);
