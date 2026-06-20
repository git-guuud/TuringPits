/**
 * The real contract layer (v3 multi-match MafiaMarket). Connects an injected wallet to the
 * deployed contract on 0G Galileo and performs the only on-chain actions a spectator takes for
 * a given `matchId`: bet YES/NO, claim a payout, and read their own stake. Pool sizes / market
 * state / outcome arrive over the WebSocket (the server reads them from this same contract), so
 * this module stays narrow.
 */
import { BrowserProvider, Contract, formatEther, parseEther } from "ethers";
import { MAFIA_MARKET_ABI } from "./abi.js";
import type { Side } from "./types.js";

/** 0G Galileo testnet (STATUS.md → confirmed facts). */
export const GALILEO = {
  chainId: 16602,
  chainIdHex: "0x40DA",
  rpcUrl: "https://evmrpc-testnet.0g.ai",
  name: "0G Galileo Testnet",
  currency: { name: "0G", symbol: "0G", decimals: 18 },
};

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

/** Claim a winning payout for a settled match. */
export async function claimPayout(address: string, matchId: number, wallet: Wallet): Promise<string> {
  const c = await writeContract(address, wallet);
  const tx = await c.getFunction("claim")(matchId);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}
