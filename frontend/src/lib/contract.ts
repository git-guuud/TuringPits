/**
 * The real contract layer (v3 multi-match MafiaMarket). Connects an injected wallet to the
 * deployed contract on 0G Galileo and performs the only on-chain actions a spectator takes for
 * a given `matchId`: bet YES/NO, claim a payout, and read their own stake. Pool sizes / market
 * state / outcome arrive over the WebSocket (the server reads them from this same contract), so
 * this module stays narrow.
 */
import { BrowserProvider, Contract, JsonRpcProvider, MaxUint256, formatEther, parseEther } from "ethers";
import { MAFIA_MARKET_ABI, MOCK_BET_TOKEN_ABI } from "./abi.js";
import type { MarketState, Outcome, Side } from "./types.js";

/**
 * Display symbol for the betting currency. Wagers are denominated in CHIP (MockBetToken), a
 * faucet-mintable ERC20 — # MOCK test money with no value — not the native 0G gas token. Gas is
 * still paid in native 0G; CHIP is only the stake/payout unit.
 */
export const BET_TOKEN_SYMBOL = "CHIP";

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
 * The single deployed MafiaMarket every match lives in (DEPLOYMENT.md). The live screen also learns
 * it from the server's match_init, but the History screen reads matches with no WebSocket, so it
 * needs the address up front. Override per-env with VITE_MARKET_ADDRESS.
 */
export const MARKET_ADDRESS =
  (import.meta.env.VITE_MARKET_ADDRESS as string | undefined) || "0xe371b4592a74a1Fda217956E52e07C5E821DA44F";

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
  if (raw.includes("insufficient balance") || raw.includes("below min bet")) {
    return "Not enough CHIP — tap “Get test tokens” to mint more, then try again.";
  }
  if (raw.includes("insufficient allowance")) {
    return "Approval needed — confirm the token approval, then place your wager again.";
  }
  if (code === "INSUFFICIENT_FUNDS" || raw.includes("insufficient funds")) {
    return "Not enough 0G for gas — top up from the faucet (faucet.0g.ai) and try again.";
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

/**
 * The market's bet token (CHIP) address, read once from `betToken()` and cached per market. Lets the
 * UI find the ERC20 to approve/read without a second hardcoded address.
 */
const tokenAddrCache = new Map<string, Promise<string>>();
export function betTokenAddress(marketAddress = MARKET_ADDRESS): Promise<string> {
  let p = tokenAddrCache.get(marketAddress);
  if (!p) {
    p = (async () => {
      const c = new Contract(marketAddress, MAFIA_MARKET_ABI, readProvider());
      return (await c.getFunction("betToken")()) as string;
    })().catch((e) => {
      tokenAddrCache.delete(marketAddress); // don't cache a transient RPC failure
      throw e;
    });
    tokenAddrCache.set(marketAddress, p);
  }
  return p;
}

/** The wallet's CHIP (bet token) balance as a decimal string — the stake currency shown in the UI. */
export async function getBalance(wallet: Wallet, marketAddress = MARKET_ADDRESS): Promise<string> {
  const token = new Contract(await betTokenAddress(marketAddress), MOCK_BET_TOKEN_ABI, wallet.provider);
  const wei = (await token.getFunction("balanceOf")(wallet.account)) as bigint;
  return formatEther(wei);
}

/**
 * Mint free test CHIP to the connected wallet via the token faucet (# MOCK — demo money). Returns the
 * tx hash once mined so the caller can refresh the balance.
 */
export async function getTestTokens(wallet: Wallet, marketAddress = MARKET_ADDRESS): Promise<string> {
  const signer = await wallet.provider.getSigner();
  const token = new Contract(await betTokenAddress(marketAddress), MOCK_BET_TOKEN_ABI, signer);
  const tx = await token.getFunction("faucet")();
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
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

/**
 * Read any account's stake on any match via the public provider (no connected wallet needed). Used
 * by the prior-positions tracker to scan past matches the bettor wagered on after the live view has
 * moved on to a new round.
 */
export async function readStakesPublic(address: string, matchId: number, account: string): Promise<MyStakes> {
  const c = new Contract(address, MAFIA_MARKET_ABI, readProvider());
  const [yes, no, claimed] = await Promise.all([
    c.getFunction("stakeYes")(matchId, account) as Promise<bigint>,
    c.getFunction("stakeNo")(matchId, account) as Promise<bigint>,
    c.getFunction("claimed")(matchId, account) as Promise<boolean>,
  ]);
  return { yes: formatEther(yes), no: formatEther(no), claimed };
}

/**
 * Place a real wager on a match. `amount` is a decimal string of CHIP (e.g. "0.01"). Bets are pulled
 * via ERC20 transferFrom, so this first ensures the market is approved to spend at least `amount`
 * CHIP (a one-time max approval), then stakes. Returns the bet tx hash.
 */
export async function placeBet(address: string, matchId: number, wallet: Wallet, side: Side, amount: string): Promise<string> {
  const value = parseEther(amount);
  const signer = await wallet.provider.getSigner();
  const token = new Contract(await betTokenAddress(address), MOCK_BET_TOKEN_ABI, signer);
  const allowance = (await token.getFunction("allowance")(wallet.account, address)) as bigint;
  if (allowance < value) {
    const approveTx = await token.getFunction("approve")(address, MaxUint256);
    await approveTx.wait();
  }
  const c = await writeContract(address, wallet);
  const tx = side === "YES" ? await c.getFunction("betYes")(matchId, value) : await c.getFunction("betNo")(matchId, value);
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

/**
 * Flip an abandoned match (Created/Locked, past its settlement deadline) into RefundMode so its
 * stakes become refundable. Permissionless — normally the server does this automatically, but the
 * UI exposes it as a self-serve fallback. After this confirms, the bettor can call refundStake.
 */
export async function enterRefundMode(address: string, matchId: number, wallet: Wallet): Promise<string> {
  const c = await writeContract(address, wallet);
  const tx = await c.getFunction("enterRefundMode")(matchId);
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
  /** Raw on-chain MatchState enum (0 None,1 Created,2 Locked,3 Settled,4 RefundMode). Lets callers
   *  distinguish Created vs. Locked, which both collapse to "OPEN"/"LOCKED" in `state`. */
  rawState: number;
  outcome?: Outcome;
  winningSide?: Side;
  yesPool: string;
  noPool: string;
  /** Net pot (gross − fee) and winning-pool size — set once SETTLED; used to size a winning claim. */
  netPot: string;
  winningPool: string;
  /** Block after which an unsettled match may be flipped to RefundMode. */
  settlementDeadlineBlock: number;
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
    rawState: Number(m.state),
    outcome,
    winningSide: outcome === "YES" || outcome === "NO" ? outcome : undefined,
    yesPool: formatEther(m.poolYes as bigint),
    noPool: formatEther(m.poolNo as bigint),
    netPot: formatEther(m.netPot as bigint),
    winningPool: formatEther(m.winningPool as bigint),
    settlementDeadlineBlock: Number(m.settlementDeadlineBlock),
    feeBpsDraw: Number(m.feeBpsDraw),
  };
}

/** Current block height from the public provider — to tell if a match is past its deadline. */
export async function currentBlock(): Promise<number> {
  return readProvider().getBlockNumber();
}

/** How many matches the contract has ever created; History walks [0, nextMatchId). */
export async function readNextMatchId(address = MARKET_ADDRESS): Promise<number> {
  const c = new Contract(address, MAFIA_MARKET_ABI, readProvider());
  return Number((await c.getFunction("nextMatchId")()) as bigint);
}

/** A past battle as the History screen lists it — outcome, pools, and the bits a card renders. */
export interface MatchSummary extends MarketRead {
  matchId: number;
  playerCount: number;
  nonce: string;
}

/** Read one match's summary (no wallet) for the History list. */
export async function readMatchSummary(matchId: number, address = MARKET_ADDRESS): Promise<MatchSummary> {
  const c = new Contract(address, MAFIA_MARKET_ABI, readProvider());
  const m = await c.getFunction("matches")(matchId);
  const outcome = OUTCOME[Number(m.outcome)];
  return {
    matchId,
    state: MARKET_STATE[Number(m.state)] ?? "OPEN",
    rawState: Number(m.state),
    outcome,
    winningSide: outcome === "YES" || outcome === "NO" ? outcome : undefined,
    yesPool: formatEther(m.poolYes as bigint),
    noPool: formatEther(m.poolNo as bigint),
    netPot: formatEther(m.netPot as bigint),
    winningPool: formatEther(m.winningPool as bigint),
    settlementDeadlineBlock: Number(m.settlementDeadlineBlock),
    feeBpsDraw: Number(m.feeBpsDraw),
    playerCount: Number(m.playerCount),
    nonce: m.nonce as string,
  };
}
