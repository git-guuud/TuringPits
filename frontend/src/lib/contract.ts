/**
 * The real contract layer (v3 multi-match MafiaMarket). Connects an injected wallet to the
 * deployed contract on 0G Galileo and performs the only on-chain actions a spectator takes for
 * a given `matchId`: bet YES/NO, claim a payout, and read their own stake. Pool sizes / market
 * state / outcome arrive over the WebSocket (the server reads them from this same contract), so
 * this module stays narrow.
 */
import { BrowserProvider, Contract, JsonRpcProvider, formatEther, parseEther } from "ethers";
import { MAFIA_MARKET_ABI } from "./abi.js";
import type { MarketState, Outcome, Side } from "./types.js";

/** 0G Galileo testnet (STATUS.md → confirmed facts). */
export const GALILEO = {
  chainId: 16602,
  chainIdHex: "0x40DA",
  rpcUrl: "https://evmrpc-testnet.0g.ai",
  name: "0G Galileo Testnet",
  currency: { name: "0G", symbol: "0G", decimals: 18 },
  explorerUrl: "https://chainscan-galileo.0g.ai",
  faucetUrl: "https://faucet.0g.ai",
};

/** Public block-explorer link for a transaction hash. */
export function explorerTx(hash: string): string {
  return `${GALILEO.explorerUrl}/tx/${hash}`;
}

/**
 * Turn a raw wallet/ethers error into a single plain-language line for the bettor. Wallet errors
 * are verbose and scary ("user rejected action (action=…)", revert blobs); the UI shows this
 * instead, keeping the raw text only for the console.
 */
export function humanizeTxError(e: unknown): string {
  const err = e as { code?: string | number; reason?: string; shortMessage?: string; message?: string };
  const code = err?.code;
  const raw = `${err?.reason ?? ""} ${err?.shortMessage ?? ""} ${err?.message ?? ""}`.toLowerCase();

  if (code === "ACTION_REJECTED" || code === 4001 || raw.includes("user rejected") || raw.includes("user denied")) {
    return "Wager cancelled.";
  }
  if (code === "INSUFFICIENT_FUNDS" || raw.includes("insufficient funds")) {
    return "Not enough 0G — top up from the faucet (faucet.0g.ai) and try again.";
  }
  if (raw.includes("no wallet found")) {
    return "No wallet found. Install MetaMask (or any EIP-1193 wallet) to bet.";
  }
  if (raw.includes("betting not started")) return "Wagers haven't opened yet — hold on a moment.";
  if (raw.includes("betting closed") || raw.includes("betting locked")) return "Wagers just closed for this match.";
  if (raw.includes("wrong network") || raw.includes("chain") || raw.includes("network")) {
    return "Wrong network — switch your wallet to 0G Galileo.";
  }
  if (raw.includes("nothing to claim") || raw.includes("already claimed")) return "Nothing to claim on this wallet.";

  // Fall back to the most specific message the wallet gave, trimmed to a sane length.
  const msg = err?.shortMessage || err?.reason || err?.message || "Transaction failed.";
  return msg.length > 140 ? `${msg.slice(0, 137)}…` : msg;
}

export interface Wallet {
  account: string;
  chainId: number;
  provider: BrowserProvider;
}

function injected(): import("ethers").Eip1193Provider {
  const eth = (window as unknown as { ethereum?: import("ethers").Eip1193Provider }).ethereum;
  if (!eth) throw new Error("No wallet found. Install MetaMask (or any EIP-1193 wallet) to bet.");
  return eth;
}

/** Connect the wallet and ensure it is on 0G Galileo (adds the chain if missing). */
export async function connectWallet(): Promise<Wallet> {
  const eth = injected();
  const provider = new BrowserProvider(eth);
  await provider.send("eth_requestAccounts", []);

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== GALILEO.chainId) {
    try {
      await provider.send("wallet_switchEthereumChain", [{ chainId: GALILEO.chainIdHex }]);
    } catch {
      await provider.send("wallet_addEthereumChain", [
        {
          chainId: GALILEO.chainIdHex,
          chainName: GALILEO.name,
          rpcUrls: [GALILEO.rpcUrl],
          nativeCurrency: GALILEO.currency,
        },
      ]);
    }
  }

  const signer = await provider.getSigner();
  const account = await signer.getAddress();
  const chainId = Number((await provider.getNetwork()).chainId);
  return { account, chainId, provider };
}

/** The wallet's native 0G balance as a decimal string (for display + a "Max" stake chip). */
export async function getBalance(wallet: Wallet): Promise<string> {
  const wei = await wallet.provider.getBalance(wallet.account);
  return formatEther(wei);
}

function readContract(address: string, wallet: Wallet) {
  return new Contract(address, MAFIA_MARKET_ABI, wallet.provider);
}

async function writeContract(address: string, wallet: Wallet) {
  const signer = await wallet.provider.getSigner();
  return new Contract(address, MAFIA_MARKET_ABI, signer);
}

export interface MyStakes {
  yes: string; // 0G decimal string
  no: string;
  claimed: boolean;
}

/** Read the connected wallet's own stake + claimed flag for this match. */
export async function readMyStakes(address: string, matchId: number, wallet: Wallet): Promise<MyStakes> {
  const c = readContract(address, wallet);
  const [yes, no, claimed] = await Promise.all([
    c.getFunction("stakeYes")(matchId, wallet.account) as Promise<bigint>,
    c.getFunction("stakeNo")(matchId, wallet.account) as Promise<bigint>,
    c.getFunction("claimed")(matchId, wallet.account) as Promise<boolean>,
  ]);
  return { yes: formatEther(yes), no: formatEther(no), claimed };
}

/** Place a real wager on a match. `amount` is a decimal string of 0G (e.g. "0.01"). */
export async function placeBet(address: string, matchId: number, wallet: Wallet, side: Side, amount: string): Promise<string> {
  const c = await writeContract(address, wallet);
  const value = parseEther(amount);
  const tx = side === "YES" ? await c.getFunction("betYes")(matchId, { value }) : await c.getFunction("betNo")(matchId, { value });
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

/**
 * Claim from a SETTLED match. The same call covers a winning payout (Yes/No) and a returned stake
 * (Draw = stake less the draw fee, Void = full stake) — the contract pays per the resolved outcome.
 */
export async function claimPayout(address: string, matchId: number, wallet: Wallet): Promise<string> {
  const c = await writeContract(address, wallet);
  const tx = await c.getFunction("claim")(matchId);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

/** Reclaim stake from a match in RefundMode (host never settled past the deadline). */
export async function refundStake(address: string, matchId: number, wallet: Wallet): Promise<string> {
  const c = await writeContract(address, wallet);
  const tx = await c.getFunction("refund")(matchId);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

const MARKET_STATE: Record<number, MarketState> = { 2: "LOCKED", 3: "SETTLED", 4: "REFUND" };
const OUTCOME: Record<number, Outcome> = { 1: "YES", 2: "NO", 3: "DRAW", 4: "VOID" };

/** Public read-only provider — no wallet needed to read contract state. */
let publicProvider: JsonRpcProvider | null = null;
const readProvider = () => (publicProvider ??= new JsonRpcProvider(GALILEO.rpcUrl, GALILEO.chainId));

export interface MarketRead {
  state: MarketState;
  outcome?: Outcome;
  winningSide?: Side;
  yesPool: string;
  noPool: string;
  feeBpsDraw: number;
}

/**
 * Read the match's on-chain state directly (no wallet). A liveness fallback: if the server stops
 * pushing — crashed mid-match, or someone moved the match into RefundMode after the deadline — the
 * client can still discover the terminal state and guide the bettor to claim/refund.
 */
export async function readMarketState(address: string, matchId: number): Promise<MarketRead> {
  const c = new Contract(address, MAFIA_MARKET_ABI, readProvider());
  const m = await c.getFunction("matches")(matchId);
  const outcome = OUTCOME[Number(m.outcome)];
  return {
    state: MARKET_STATE[Number(m.state)] ?? "OPEN",
    outcome,
    winningSide: outcome === "YES" || outcome === "NO" ? outcome : undefined,
    yesPool: formatEther(m.poolYes as bigint),
    noPool: formatEther(m.poolNo as bigint),
    feeBpsDraw: Number(m.feeBpsDraw),
  };
}
