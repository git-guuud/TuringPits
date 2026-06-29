/**
 * The real contract layer (v3 multi-match MafiaMarket). Connects an injected wallet to the
 * deployed contract on 0G Galileo and performs the only on-chain actions a spectator takes for
 * a given `matchId`: bet YES/NO, claim a payout, and read their own stake. Pool sizes / market
 * state / outcome arrive over the WebSocket (the server reads them from this same contract), so
 * this module stays narrow.
 */
import { BrowserProvider, Contract, JsonRpcProvider, MaxUint256, formatEther, parseEther } from "ethers";
import { MAFIA_MARKET_ABI, MOCK_BET_TOKEN_ABI } from "./abi.js";
import type { MarketState, Outcome, PropSnapshot, Side } from "./types.js";

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
  // 0G Storage explorer (StorageScan) — file lookup by content root (the bytes32 CID committed
  // on-chain). Used to surface the transcript / persona-pool evidence as verifiable links.
  storageScanUrl: "https://storagescan-galileo.0g.ai",
  faucetUrl: "https://faucet.0g.ai",
};

/** Public block-explorer link for a transaction hash. */
export function explorerTx(hash: string): string {
  return `${GALILEO.explorerUrl}/tx/${hash}`;
}

/** Public block-explorer link for a wallet / contract address. */
export function explorerAddress(address: string): string {
  return `${GALILEO.explorerUrl}/address/${address}`;
}

/** Block-explorer token page (holders + transfers) for an ERC20 such as CHIP. */
export function explorerToken(address: string): string {
  return `${GALILEO.explorerUrl}/token/${address}`;
}

/**
 * 0G Storage (StorageScan) link for a stored file by its content root — the bytes32 `cid` we commit
 * on-chain for the match transcript and the persona pool. This is the verifiable-evidence deep link
 * (StorageScan's own file-detail route).
 */
export function storageScanFile(cid: string): string {
  return `${GALILEO.storageScanUrl}/files/info?cid=${cid}`;
}

/**
 * The single deployed MafiaMarket every match lives in (DEPLOYMENT.md). The live screen also learns
 * it from the server's match_init, but the History screen reads matches with no WebSocket, so it
 * needs the address up front. Override per-env with VITE_MARKET_ADDRESS.
 */
export const MARKET_ADDRESS =
  (import.meta.env.VITE_MARKET_ADDRESS as string | undefined) || "0xBCB635Bb7a9454F665288Ed9c6E99214C284D240";

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
 * Place a wager on a categorical side market by staking on ONE `outcome` (PlayerFate: a death-round
 * bucket; RoundVotedOut: a seat or "no one"). Mirrors placeBet: ensures the market is approved to spend
 * CHIP, then stakes via betProp. Returns the bet tx hash.
 */
export async function placePropBet(
  address: string,
  matchId: number,
  propIdx: number,
  wallet: Wallet,
  outcome: number,
  amount: string,
): Promise<string> {
  const value = parseEther(amount);
  const signer = await wallet.provider.getSigner();
  const token = new Contract(await betTokenAddress(address), MOCK_BET_TOKEN_ABI, signer);
  const allowance = (await token.getFunction("allowance")(wallet.account, address)) as bigint;
  if (allowance < value) {
    const approveTx = await token.getFunction("approve")(address, MaxUint256);
    await approveTx.wait();
  }
  const c = await writeContract(address, wallet);
  const tx = await c.getFunction("betProp")(matchId, propIdx, outcome, value);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

/** Claim a side-market payout/returned stake from a SETTLED match (RESOLVED pays the winner, VOID refunds). */
export async function claimPropPayout(address: string, matchId: number, propIdx: number, wallet: Wallet): Promise<string> {
  const c = await writeContract(address, wallet);
  const tx = await c.getFunction("claimProp")(matchId, propIdx);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

/** Reclaim a side-market stake from a match in RefundMode (host never settled). */
export async function refundPropStake(address: string, matchId: number, propIdx: number, wallet: Wallet): Promise<string> {
  const c = await writeContract(address, wallet);
  const tx = await c.getFunction("refundProp")(matchId, propIdx);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

export interface MyPropStake {
  index: number;
  numOutcomes: number;
  /** The wallet's stake on each outcome (CHIP decimal strings), length == numOutcomes. */
  stakes: string[];
  claimed: boolean;
}

/** Read the connected wallet's own per-outcome stake + claimed flag on each prop of a match. */
export async function readMyPropStakes(address: string, matchId: number, propCount: number, wallet: Wallet): Promise<MyPropStake[]> {
  const c = readContract(address, wallet);
  return Promise.all(
    Array.from({ length: propCount }, async (_, i) => {
      const pr = await c.getFunction("getProp")(matchId, i);
      const numOutcomes = Number(pr.numOutcomes);
      const [claimed, stakeWeis] = await Promise.all([
        c.getFunction("propClaimed")(matchId, i, wallet.account) as Promise<boolean>,
        Promise.all(
          Array.from({ length: numOutcomes }, (_, o) => c.getFunction("propStake")(matchId, i, o, wallet.account) as Promise<bigint>),
        ),
      ]);
      return { index: i, numOutcomes, stakes: stakeWeis.map((s) => formatEther(s)), claimed };
    }),
  );
}

/** A wallet's position on one side market of a past match, with the figures to size a claim. */
export interface PropPosition {
  index: number;
  kind: PropSnapshot["kind"];
  /** PLAYER_FATE: the seat. ROUND_VOTED_OUT: the 1-based day-vote round. */
  param: number;
  numOutcomes: number;
  /** Settled state (RESOLVED winner / VOID refund), or undefined while unresolved. */
  state?: PropSnapshot["state"];
  /** The winning outcome index, set when state == RESOLVED. */
  winningOutcome?: number;
  netPot: string;
  winningPool: string;
  /** The wallet's stake on each outcome (CHIP decimal strings), length == numOutcomes. */
  stakes: string[];
  claimed: boolean;
}

/**
 * Read the connected account's positions across every categorical side market of a match (PlayerFate +
 * RoundVotedOut), via the public provider (no wallet) — used by the History screen to surface
 * reclaimable side pots on past battles. Only call this for terminal (settled/refund) matches.
 */
export async function readPropPositions(address: string, matchId: number, account: string): Promise<PropPosition[]> {
  const c = new Contract(address, MAFIA_MARKET_ABI, readProvider());
  const count = Number((await c.getFunction("propCount")(matchId)) as bigint);
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const pr = await c.getFunction("getProp")(matchId, i);
      const numOutcomes = Number(pr.numOutcomes);
      const [claimed, stakeWeis] = await Promise.all([
        c.getFunction("propClaimed")(matchId, i, account) as Promise<boolean>,
        Promise.all(
          Array.from({ length: numOutcomes }, (_, o) => c.getFunction("propStake")(matchId, i, o, account) as Promise<bigint>),
        ),
      ]);
      const state = PROP_STATE[Number(pr.state)];
      return {
        index: i,
        kind: PROP_KIND[Number(pr.kind)] ?? "PLAYER_FATE",
        param: Number(pr.param),
        numOutcomes,
        state,
        winningOutcome: state === "RESOLVED" ? Number(pr.winningOutcome) : undefined,
        netPot: formatEther(pr.netPot as bigint),
        winningPool: formatEther(pr.winningPool as bigint),
        stakes: stakeWeis.map((s) => formatEther(s)),
        claimed,
      };
    }),
  );
}

/**
 * Read the side markets for a match from the contract (no wallet) — a fallback for when the server
 * isn't pushing `props` over the WebSocket (e.g. the History screen, or a crashed server).
 */
export async function readProps(address: string, matchId: number): Promise<PropSnapshot[]> {
  const c = new Contract(address, MAFIA_MARKET_ABI, readProvider());
  const count = Number((await c.getFunction("propCount")(matchId)) as bigint);
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const pr = await c.getFunction("getProp")(matchId, i);
      const state = PROP_STATE[Number(pr.state)];
      return {
        index: i,
        kind: PROP_KIND[Number(pr.kind)] ?? "PLAYER_FATE",
        param: Number(pr.param),
        numOutcomes: Number(pr.numOutcomes),
        pools: (pr.pools as bigint[]).map((p) => formatEther(p)),
        closed: Boolean(pr.closed),
        state,
        winningOutcome: state === "RESOLVED" ? Number(pr.winningOutcome) : undefined,
      };
    }),
  );
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
/** MafiaMarket PropKind enum → wire label (0 = PlayerFate, 1 = RoundVotedOut). */
const PROP_KIND: Record<number, PropSnapshot["kind"]> = { 0: "PLAYER_FATE", 1: "ROUND_VOTED_OUT" };
/** MafiaMarket PropState enum → wire state (1 = Resolved, 2 = Void; 0 = Unset → undefined). */
const PROP_STATE: Record<number, PropSnapshot["state"]> = { 1: "RESOLVED", 2: "VOID" };

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
