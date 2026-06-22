import * as players from "@turingpits/players";
const RPC = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.TEE_PROVIDER_ADDRESS;
const base = await players.createZeroGDirectProvider({ privateKey: KEY, rpcUrl: RPC, providerAddress: PROVIDER_ADDR });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const provider = { teeSignerAddress: base.teeSignerAddress, async complete(p, o){ for(let a=0;;a++){ try { return await base.complete(p,o);} catch(e){ const m=[e?.message,e?.code].filter(Boolean).join(" ")||String(e); if(/429|fetch failed|ETIMEDOUT|timeout|auto-funding|50[234]/i.test(m)&&a<15){await sleep(/429/.test(m)?30000:10000);continue;} throw e; } } } };
const roster = [
  { seat:0,name:"Ada",blurb:"a cold vote-counter; clipped, math-first, no warmth"},
  { seat:1,name:"Boris",blurb:"a loud brawler; first to accuse, swings hard and fast"},
  { seat:2,name:"Cleo",blurb:"a silver-tongued peacemaker who slows every rush to vote"},
  { seat:3,name:"Dmitri",blurb:"a sardonic contrarian who distrusts the obvious read"},
  { seat:4,name:"Esme",blurb:"a patient strategist who speaks rarely but lands hard"},
  { seat:5,name:"Felix",blurb:"a blunt prosecutor who demands hard evidence for everything"},
];
const ctx = { persona:roster[4], role:"DETECTIVE", alive:[0,1,3,4,5], roster,
  transcript:[[0,"Today's vote should focus on finding the Mafia. Boris, any insights?"],[1,"I've no reason to suspect myself — why are you so eager, Ada?"],[3,"Boris' eagerness feels off to me; I'd look at him."]],
  decisionStub:{nonce:"reveal-probe",phase:"day",round:1,player:4,action:"vote"}, legalTargets:[0,1,3,5], stage:"discussion",
  deaths:[{round:1,phase:"night",seat:2}], investigations:[{round:1,target:1,faction:"MAFIA"}] };
console.log("Esme (DETECTIVE) caught Boris=MAFIA night 1; day-1 discussion.\n");
const { speech } = await new players.Player(provider,{decisionRetries:4}).discuss(ctx);
console.log("\n===== Esme line =====\n"+speech+"\n=====================");
console.log("\nExplicit Detective claim? "+(/\b(I(?:'?m| am)\s+the\s+detective|I\s+investigated|my\s+investigation)/i.test(speech)?"✅ YES":"❌ NO (vague)"));
console.log("Names Boris as the target? "+(/\bBoris\b/i.test(speech)?"✅ YES":"❌ NO"));
