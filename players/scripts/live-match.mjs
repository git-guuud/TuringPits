// LIVE end-to-end run: real 0G-Compute TEE players play a full Mafia match, every
// dialogue/action/phase is logged to a file, and the attested transcript is SETTLED on a
// freshly deployed MafiaMarket on 0G Galileo.
//
//   node --env-file=.env players/scripts/live-match.mjs
//
// Outputs (repo root): live-match.md (human-readable log) + live-match.json (full transcript).
// Requires a funded COMPUTE_PRIVATE_KEY (= DEPLOYER key) and TEE_PROVIDER_ADDRESS in .env.
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ContractFactory, JsonRpcProvider, Wallet, formatEther, parseEther } from "ethers";
import * as players from "@turingpits/players";
import * as engine from "@turingpits/engine";

const require = createRequire(import.meta.url);
const artifact = require(fileURLToPath(
  new URL("../../contracts/artifacts/contracts/MafiaMarket.sol/MafiaMarket.json", import.meta.url),
));

const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG = fileURLToPath(new URL(`../../live-match-${STAMP}.md`, import.meta.url));
const JSON_OUT = fileURLToPath(new URL(`../../live-match-${STAMP}.json`, import.meta.url));
const log = (s = "") => { console.log(s); appendFileSync(LOG, s + "\n"); };

const RPC = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.TEE_PROVIDER_ADDRESS;
if (!KEY || !PROVIDER_ADDR) throw new Error("need COMPUTE_PRIVATE_KEY + TEE_PROVIDER_ADDRESS in .env");

const N = 6; // 6 agents, single-Mafia composition: ["MAFIA","DOCTOR","DETECTIVE","TOWN","TOWN","TOWN"]
const SEED = "0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
const NONCE = "live-" + Date.now();
const ROLE_ENUM = { MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 };
const PERSONAS = [
  { seat: 0, name: "Ada", blurb: "a calm tactician who watches the vote math" },
  { seat: 1, name: "Boris", blurb: "a loud accuser, first to point fingers" },
  { seat: 2, name: "Cleo", blurb: "a peacemaker who hates rushing a vote" },
  { seat: 3, name: "Dmitri", blurb: "a contrarian who distrusts the obvious read" },
  { seat: 4, name: "Esme", blurb: "a quiet strategist who speaks only when it counts" },
  { seat: 5, name: "Felix", blurb: "a blunt skeptic who demands hard evidence" },
];

// ---- Network preflight FIRST (before truncating/writing any log, so a connectivity
// failure never clobbers a prior good run). createZeroGDirectProvider hits the chain RPC.
let provider;
try {
  provider = await players.createZeroGDirectProvider({ privateKey: KEY, rpcUrl: RPC, providerAddress: PROVIDER_ADDR });
} catch (err) {
  if (/EAI_AGAIN|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(String(err.message))) {
    console.error(`\nNETWORK UNAVAILABLE — cannot reach 0G (${err.message}). Nothing written. Retry when connectivity returns.`);
    process.exit(2);
  }
  throw err;
}

writeFileSync(LOG, "");
log(`# Turing Pits — Live On-Chain Mafia Match\n`);
log(`- **When:** ${new Date().toISOString()}`);
log(`- **Network:** 0G Galileo testnet (chainId 16602), RPC ${RPC}`);
log(`- **Seed:** \`${SEED}\``);
log(`- **Nonce:** \`${NONCE}\`\n`);

// ---- 1. Real 0G Compute TEE provider (shared = one TEE signer key, as the contract expects).
log(`## 1. 0G Compute provider\n`);

// The testnet TEE endpoint caps at 10 requests/min. Gate every inference behind a global
// min-interval (≥6.5s) and back off on a 429, so a long match never trips the limit.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Treat anything network/rate/funding-flaky as retryable. The SDK's auto-funding step throws
// `request timeout` (code TIMEOUT) when topping up the provider sub-account — that aborted whole
// matches before; it is transient, so it must be retried, not fatal.
const isTransient = (m) =>
  /429|fetch failed|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|timeout|timed out|auto-funding|sub-account|502|503|504/i.test(m);
function throttled(inner, minIntervalMs = 6500) {
  let last = 0;
  return {
    teeSignerAddress: inner.teeSignerAddress,
    async complete(prompt) {
      let attempts = 0;
      for (;;) {
        const wait = last + minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        try {
          return await inner.complete(prompt);
        } catch (err) {
          // Look at message, code, AND shortMessage — the funding timeout only sets code=TIMEOUT.
          const msg = [err?.message, err?.code, err?.shortMessage].filter(Boolean).join(" ") || String(err);
          if (isTransient(msg) && attempts++ < 15) {
            const backoff = /429/.test(msg) ? 30_000 : 10_000;
            console.log(`  …transient (${msg.slice(0, 60)}), retry ${attempts} in ${backoff / 1000}s`);
            await sleep(backoff);
            continue;
          }
          throw err;
        }
      }
    },
  };
}
const rateLimited = throttled(provider);
log(`- **Model:** \`qwen2.5-omni\` (TEE inference)`);
log(`- **Registered TEE signer:** \`${provider.teeSignerAddress}\``);
log(`- **Provider account:** \`${PROVIDER_ADDR}\`\n`);

// ---- 2. Roles assigned from the secret seed; commit BEFORE betting (hidden from bettors).
const roleNames = engine.assignRoles(SEED, N);
const salt = engine.generateSalt();
const commit = engine.commitRoles(roleNames, salt);
const roles = roleNames.map((r) => ROLE_ENUM[r]);
log(`## 2. Role commit (roles stay hidden until settlement)\n`);
log(`- **Commit:** \`${commit}\`  — \`sha256(roles ++ salt)\`, binds the assignment before any bet.\n`);

// ---- 3. Play the match live, logging every turn incrementally.
log(`## 3. The match (live TEE players)\n`);
log(`_Day turns are public speech (broadcast to the table). Night turns are secret — only the`);
log(`player's private reasoning + the attested action; nothing is shown to the other players._\n`);
let curPhase = "";
const playerSeats = PERSONAS.map(() => new players.Player(rateLimited, { decisionRetries: 4 }));
const nameOf = (s) => PERSONAS[s].name;

const discussionLog = [];
const onDiscussion = (entry, state) => {
  const header = `DAY — round ${entry.round} · discussion`;
  if (header !== curPhase) { curPhase = header; log(`\n### ${header}\n`); }
  const alive = state.players.filter((p) => p.alive).map((p) => p.id);
  log(`**${nameOf(entry.seat)}** (seat ${entry.seat}, ${roleNames[entry.seat]})`);
  log(`> ${entry.speech.trim()}`);
  log(`- _open discussion (unsigned public speech)_  ·  alive: [${alive.join(", ")}]\n`);
  discussionLog.push(entry);
};

const onTurn = (turn, state) => {
  const d = turn.structuredDecision;
  const header = d.phase === "day" ? `DAY — round ${d.round} · vote` : `${d.phase.toUpperCase()} — round ${d.round}`;
  if (header !== curPhase) { curPhase = header; log(`\n### ${header}\n`); }
  const ok = players.verifyAttestation(turn.attestation) ? "✓" : "✗";
  const alive = state.players.filter((p) => p.alive).map((p) => p.id);
  const isNight = d.phase === "night";
  log(`**${nameOf(turn.seat)}** (seat ${turn.seat}, ${roleNames[turn.seat]})`);
  log(isNight ? `> _🔒 private reasoning (secret — never shown to other players):_ ${turn.speech.trim()}`
             : `> ${turn.speech.trim()}`);
  log(`- action: \`${d.action}\` → seat ${d.target} (${nameOf(d.target)})  ·  attested \`${turn.attestation.source}\` ${ok}  ·  alive: [${alive.join(", ")}]\n`);
};

let match;
try {
  match = await players.playMatch({ seed: SEED, n: N, nonce: NONCE, personas: PERSONAS, players: playerSeats, onTurn, onDiscussion });
} catch (err) {
  log(`\n**⚠️ Match aborted:** ${err.message}\n`);
  throw err;
}
log(`\n**Engine winner:** ${match.winner} faction · ${match.turns.length} attested moves.\n`);

// Persist the full attested transcript NOW, before any on-chain step — so even if settlement
// reverts, the live match (dialogue + moves + commit/salt) is never lost and can be re-settled.
writeFileSync(JSON_OUT, JSON.stringify({
  seed: SEED, nonce: NONCE, network: "0g-galileo-16602",
  teeSigner: provider.teeSignerAddress, commit, salt, roles: roleNames,
  winner: match.winner, turns: match.turns, discussion: discussionLog,
}, null, 2));

// ---- 4. On-chain settlement.
log(`## 4. On-chain settlement (0G Chain)\n`);
const wallet = new Wallet(KEY, new JsonRpcProvider(RPC, 16602));
log(`- **Host/bettor wallet:** \`${wallet.address}\` (balance ${formatEther(await wallet.provider.getBalance(wallet.address))} 0G)`);

const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
const market = await factory.deploy();
await market.waitForDeployment();
const addr = await market.getAddress();
log(`- **Deployed MafiaMarket:** \`${addr}\``);

// The market registers ONE set of provider metadata; it MUST be the REAL metadata the live
// TEE envelopes were signed under (parsed into each attestation), not the mock placeholder —
// otherwise the contract rebuilds a different envelope and `recover` yields the wrong signer.
const att0 = match.turns[0].attestation;
const m = { providerType: att0.providerType, providerIdentity: att0.providerIdentity, tlsFingerprint: att0.tlsFingerprint };
if (!match.turns.every((t) => t.attestation.providerType === m.providerType
    && t.attestation.providerIdentity === m.providerIdentity
    && t.attestation.tlsFingerprint === m.tlsFingerprint)) {
  throw new Error("provider metadata varies across moves — a single market cannot register one envelope context");
}
log(`- **Provider metadata (from the live envelope):** type=\`${m.providerType}\` identity=\`${m.providerIdentity}\` tls=\`${m.tlsFingerprint}\``);
const open = await (await market.openMarket(commit, provider.teeSignerAddress, m.providerType, m.providerIdentity, m.tlsFingerprint, NONCE, N)).wait();
log(`- **openMarket** (role commit + TEE signer registered): tx \`${open.hash}\``);

// Blind bets on BOTH sides from the one funded wallet so the settle→claim lifecycle is fully
// demonstrated regardless of who wins (roles are still hidden at bet time).
const yesBet = parseEther("0.02"), noBet = parseEther("0.01");
await (await market.placeBet(1, { value: yesBet })).wait();
await (await market.placeBet(0, { value: noBet })).wait();
log(`- **placeBet:** ${formatEther(yesBet)} 0G on YES (Mafia), ${formatEther(noBet)} 0G on NO (Town) — blind, roles hidden`);
await (await market.lockBetting()).wait();
log(`- **lockBetting:** market locked; no further bets.\n`);

const moves = match.turns.map((t) => players.toSettlementMove(t));
log(`### Reveal + settle\n`);
log(`- **Revealed roles:** ${roleNames.map((r, i) => `${nameOf(i)}=${r}`).join(", ")}`);
log(`- **Salt:** \`${salt}\``);
let settled;
try {
  settled = await (await market.settle(moves, roles, salt)).wait();
} catch (err) {
  log(`\n**⚠️ settle() reverted:** ${err.shortMessage ?? err.message}\n`);
  throw err;
}
const winningSide = await market.winningSide();
const sideName = winningSide === 0n ? "NO (Town)" : "YES (Mafia)";
log(`- **settle():** tx \`${settled.hash}\` · gas ${settled.gasUsed}`);
log(`- **On-chain winning side:** ${sideName}`);
log(`- **Cross-check:** engine winner = ${match.winner} → ${match.winner === "MAFIA" ? "YES" : "NO"} ✓\n`);

const claimed = await (await market.claim()).wait();
log(`- **claim():** tx \`${claimed.hash}\` — winning-side stake redeemed pro-rata (full pot to the sole winning bettor).\n`);

log(`## Result\n`);
log(`✅ A real TEE-attested match settled trustlessly on-chain. Every move's 0G-TEE signature`);
log(`was verified by the contract before payout; a forged or missing move would have reverted \`settle()\`.`);

// Full machine-readable transcript.
writeFileSync(JSON_OUT, JSON.stringify({
  seed: SEED, nonce: NONCE, network: "0g-galileo-16602", market: addr,
  teeSigner: provider.teeSignerAddress, commit, salt, roles: roleNames,
  winner: match.winner, winningSide: Number(winningSide),
  turns: match.turns, discussion: discussionLog,
}, null, 2));
log(`\n_Full transcript: \`live-match.json\` · this log: \`live-match.md\`._`);
console.log("\nDONE — see live-match.md");
