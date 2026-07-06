/**
 * The real contract layer (v3 multi-match MafiaMarket). Connects an injected wallet to the
 * deployed contract on 0G Galileo and performs the only on-chain actions a spectator takes for
 * a given `matchId`: stake on a market outcome (betProp), claim/refund (claimProp/refundProp),
 * and read their own stake. EVERY market — the headline faction market included — is a categorical
 * prop. Pool sizes / market state arrive over the WebSocket (the server reads them from this same
 * contract), so this module stays narrow.
 */
import { BrowserProvider, Contract, Interface, JsonRpcProvider, MaxUint256, Wallet as EthWallet, formatEther, keccak256, parseEther } from "ethers";
import { MAFIA_MARKET_ABI, MOCK_BET_TOKEN_ABI } from "./abi.js";
import type { MarketState, PropSnapshot } from "./types.js";

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
  // 0G Storage explorer (StorageScan). Its human file page is keyed by upload tx-sequence, not by the
  // merkle root we commit on-chain — so a root is resolved to its sequence via the Open API (see
  // resolveStorageScanUrl) before deep-linking. Used to surface the transcript / persona-pool evidence.
  storageScanUrl: "https://storagescan-galileo.0g.ai",
  // Turbo storage indexer. Its /file/info/<root> endpoint IS addressed by merkle root and returns the
  // stored-and-finalized proof directly — the always-valid evidence link + fallback when the pretty
  // StorageScan page can't be resolved (e.g. the upload isn't indexed yet).
  storageIndexerUrl: "https://indexer-storage-testnet-turbo.0g.ai",
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
 * Direct, always-valid 0G Storage evidence link: the Turbo indexer's file-info endpoint, addressed by
 * the exact merkle `root` committed on-chain. Returns `{ tx: { seq, size, ... }, finalized }` JSON —
 * proof the bytes are stored under this root. Used as the immediate link and the fallback when the
 * prettier StorageScan page can't be resolved.
 */
export function storageFileInfoUrl(root: string): string {
  return `${GALILEO.storageIndexerUrl}/file/info/${root}`;
}

/**
 * Resolve a stored merkle `root` to its human-readable StorageScan file page. StorageScan keys pages by
 * the upload's tx-sequence (`/submission/<seq>`), NOT by root, so we look the root up through its Open
 * API (`/api/txs?rootHash=…`, CORS-open) and build the deep link. Returns null when the upload isn't
 * indexed yet (the caller keeps the direct indexer link). Cached per root so History's many rows dedupe.
 */
const storageScanCache = new Map<string, Promise<string | null>>();
export function resolveStorageScanUrl(root: string): Promise<string | null> {
  let p = storageScanCache.get(root);
  if (!p) {
    p = fetch(`${GALILEO.storageScanUrl}/api/txs?rootHash=${root}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: { list?: { txSeq?: number }[] } }>) : null))
      .then((j) => {
        const seq = j?.data?.list?.[0]?.txSeq;
        return typeof seq === "number" ? `${GALILEO.storageScanUrl}/submission/${seq}` : null;
      })
      .catch(() => null);
    storageScanCache.set(root, p);
  }
  return p;
}

/**
 * The single deployed MafiaMarket every match lives in (DEPLOYMENT.md). The live screen also learns
 * it from the server's match_init, but the History screen reads matches with no WebSocket, so it
 * needs the address up front. Override per-env with VITE_MARKET_ADDRESS.
 */
export const MARKET_ADDRESS =
  (import.meta.env.VITE_MARKET_ADDRESS as string | undefined) || "0x35fCb9De839700ED139077ECB183257dD10C581f";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Optional EIP-2771 gas relayer ("gasless" path). A bettor signs a ForwardRequest (free); the
// server's relayer submits it and pays the 0G gas. The user stays the on-chain bettor. All of this
// is OPTIONAL — if the server has no relayer (or it's out of gas) the helpers below fall back to the
// normal user-pays-gas path. See server/src/relayer.ts and contracts/Forwarder.sol.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Base URL of the relayer HTTP endpoint. Mirrors feed.ts:resolveWsUrl so one tunnel covers both. */
function resolveRelayBase(): string {
  const override = import.meta.env.VITE_RELAYER_URL as string | undefined;
  if (override) return override.replace(/\/$/, "");
  const { hostname, host, protocol } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") return "http://localhost:8080";
  return `${protocol === "https:" ? "https" : "http"}://${host}`;
}

export interface RelayInfo {
  enabled: boolean;
  /** Does the relayer wallet still hold enough 0G to sponsor a tx? When false, use the direct path. */
  funded: boolean;
  forwarder: string;
  market: string;
  token: string;
  relayer: string;
  chainId: number;
  relayerBalance: string;
}

let relayInfoCache: Promise<RelayInfo | null> | null = null;

/**
 * Discover the relayer config (cached). Returns null when no relayer is configured/reachable — the
 * signal the UI uses to default the gasless toggle on/off. Pass force=true to re-poll (e.g. to
 * refresh the `funded` flag after a long session).
 */
export function relayInfo(force = false): Promise<RelayInfo | null> {
  if (force) relayInfoCache = null;
  if (!relayInfoCache) {
    relayInfoCache = fetch(`${resolveRelayBase()}/relay/info`)
      .then((r) => (r.ok ? (r.json() as Promise<RelayInfo>) : null))
      .then((info) => (info?.enabled ? info : null))
      .catch(() => null);
  }
  return relayInfoCache;
}

/**
 * Read-only lobby status, mirrored from the server's `GET /status` (derived from its in-memory match
 * buffer). Lets the Menu show "is court in session, what round, how big the pot" WITHOUT opening the
 * live WebSocket — opening one would start a match. See server/src/broadcast.ts `MatchStatus`.
 */
export interface MatchStatus {
  live: boolean;
  matchId: number | null;
  round: number;
  state: string;
  bettingLive: boolean;
  /** Total staked on the headline FACTION market (CHIP decimal string) — the lobby's "pot" figure. */
  pot: string;
  isMock: boolean;
}

/** Fetch the current match status. Returns null on any failure — it is display-only. */
export function fetchMatchStatus(): Promise<MatchStatus | null> {
  return fetch(`${resolveRelayBase()}/status`)
    .then((r) => (r.ok ? (r.json() as Promise<MatchStatus>) : null))
    .catch(() => null);
}

/** Thrown when the gasless path can't be used (no relayer, or it's out of gas) — callers fall back. */
export class RelayUnavailable extends Error {}

const FORWARDER_TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
};

/** Gas forwarded to each relayed inner call — comfortably covers approve/bet/claim, under the server cap. */
const RELAY_GAS = 600_000n;
/** A collect-all sweeps several markets in one call, so it gets the full headroom (== the server gas cap). */
const BATCH_RELAY_GAS = 700_000n;

// Pure encoders (no provider) for building the calldata we relay.
const marketIface = new Interface(MAFIA_MARKET_ABI);
const tokenIface = new Interface(MOCK_BET_TOKEN_ABI);

/**
 * Sign a ForwardRequest for `to`+`data` and POST it to the relayer, which submits it on-chain and
 * pays gas. Resolves to the inner tx hash once mined. Throws RelayUnavailable if the relayer is
 * absent/broke so the caller can fall back to a normal (user-paid) transaction.
 */
async function signAndRelay(wallet: Wallet, to: string, data: string, gas: bigint = RELAY_GAS): Promise<string> {
  const info = await relayInfo();
  if (!info || !info.enabled || !info.funded) throw new RelayUnavailable("relayer unavailable");

  // A session/guest wallet signs the request with its in-browser key (no pop-up); an injected wallet
  // asks its provider for the user's signer (which prompts). Either way `from` stays the bettor's address.
  const signer = wallet.session ?? (await wallet.provider.getSigner());
  const from = wallet.account;
  const fwd = new Contract(info.forwarder, ["function getNonce(address) view returns (uint256)"], readProvider());
  const nonce = (await fwd.getFunction("getNonce")(from)) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const domain = { name: "TuringPitsForwarder", version: "1", chainId: info.chainId, verifyingContract: info.forwarder };
  const message = { from, to, value: 0n, gas, nonce, deadline, data };
  const signature = await signer.signTypedData(domain, FORWARDER_TYPES, message);

  // Serialize the bigints as strings for JSON; the server parses them back with BigInt(...).
  const request = { from, to, value: "0", gas: gas.toString(), nonce: nonce.toString(), deadline: deadline.toString(), data };
  const res = await fetch(`${resolveRelayBase()}/relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request, signature }),
  });
  if (res.status === 503) throw new RelayUnavailable("relayer out of gas");
  const body = (await res.json().catch(() => ({}))) as { txHash?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? "Relay failed.");
  const txHash = body.txHash ?? "";
  if (txHash) await readProvider().waitForTransaction(txHash);
  return txHash;
}

/**
 * Run `relayFn` when gasless, but transparently fall back to `directFn` (a normal user-paid tx) if
 * the relayer is unavailable/out of gas. Any other relay error (e.g. a contract revert) propagates.
 *
 * A session/guest wallet holds no native 0G, so it can ONLY transact through the relayer: we force the
 * relay path for it and never fall through to a (doomed) gas-paying tx — a clear error surfaces instead.
 */
async function withGasless(
  wallet: Wallet,
  gasless: boolean,
  relayFn: () => Promise<string>,
  directFn: () => Promise<string>,
): Promise<string> {
  const mustRelay = wallet.kind === "session";
  if (gasless || mustRelay) {
    try {
      return await relayFn();
    } catch (e) {
      if (mustRelay) {
        if (e instanceof RelayUnavailable) {
          throw new Error(
            "The gas relayer is offline right now — a session wallet needs it to bet. Try again in a moment, or connect your own wallet.",
          );
        }
        throw e;
      }
      if (!(e instanceof RelayUnavailable)) throw e;
      // relayer can't sponsor right now → fall through to the user's own wallet
    }
  }
  return directFn();
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
  if (raw.includes("insufficient balance") || raw.includes("below min bet")) {
    return "Not enough CHIP — tap “Get test CHIP” to mint more, then try again.";
  }
  if (raw.includes("insufficient allowance")) {
    return "Approval needed — confirm the token approval, then place your wager again.";
  }
  if (code === "INSUFFICIENT_FUNDS" || raw.includes("insufficient funds")) {
    return "Not enough 0G for gas — top up from the faucet (faucet.0g.ai) and try again.";
  }
  if (raw.includes("no wallet found")) {
    return "No wallet found — install MetaMask, or tap “Play as guest” to bet with a browser wallet.";
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
  /** Read/sign provider. A BrowserProvider for an injected wallet; the public JsonRpcProvider for a session key. */
  provider: BrowserProvider | JsonRpcProvider;
  /**
   * When present, this in-browser key signs relayed ForwardRequests LOCALLY, with NO wallet pop-up —
   * the whole point of the session/guest path. Its address IS `account`, so it stays the on-chain
   * bettor. It never holds native 0G (the relayer pays gas), so a session wallet ALWAYS transacts via
   * the relayer — see `withGasless`, which forces the relay path for it.
   */
  session?: EthWallet;
  /** How the on-chain identity is held: an injected wallet the user signs each tx with, or an in-browser session key. */
  kind: "injected" | "session";
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
  return { account, chainId, provider, kind: "injected" };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Session / guest keys — the pop-up-free betting path (design Option 1). An in-browser key is the
// on-chain bettor: it signs relayed ForwardRequests LOCALLY (no wallet pop-up) and the relayer pays
// gas, so the key never needs native 0G. Two ways to obtain it:
//   • connectSessionWallet() — DERIVE it deterministically from ONE signature by the user's injected
//     wallet ("TuringPits session v1"). Same user → same betting identity, but one pop-up ever.
//   • connectBurnerWallet()  — a pure random burner for when there is no wallet, or the user would
//     rather not sign. Persisted so its CHIP / positions survive a reload.
// # MOCK-money scope — SECURITY: these private keys live in the browser (localStorage). Acceptable ONLY
// because the stake is faucet-mintable mock CHIP on a testnet AND the relayer's allowlist restricts a
// relayed key to bet/claim/faucet/approve on the one market — a leaked key can do nothing else.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The exact message the injected wallet signs to seed a deterministic session key. Bump the suffix to rotate. */
const SESSION_SIGN_MESSAGE = "TuringPits session v1";
/** localStorage key for the pure guest burner's private key. */
const BURNER_STORE_KEY = "turingpits.burner.v1";
/** localStorage key prefix for a derived session key, namespaced by the owner address (lowercased). */
const DERIVED_STORE_PREFIX = "turingpits.session.v1:";

function lsGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // storage blocked (private mode / disabled) — the caller just re-derives instead of caching
  }
}
function lsSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage may be blocked; the key simply won't persist across reloads */
  }
}

/**
 * Deterministically turn an injected-wallet signature into a secp256k1 private key: keccak256 of the
 * signature yields 32 bytes that are (overwhelmingly) a valid key. Because signatures are deterministic
 * (RFC-6979, as MetaMask uses), the same account always reproduces the same session identity — so the
 * one signature is the only pop-up the user ever sees, even on a fresh device / cleared cache.
 */
export function sessionKeyFromSignature(signature: string): string {
  return keccak256(signature);
}

/** Wrap an in-browser private key as a session Wallet — the on-chain bettor, reads via the public provider. */
function sessionWalletFrom(privateKey: string): Wallet {
  const key = new EthWallet(privateKey, readProvider());
  return { account: key.address, chainId: GALILEO.chainId, provider: readProvider(), session: key, kind: "session" };
}

/**
 * Derive an in-browser session key from the injected wallet with a SINGLE message signature (cached per
 * owner, so it's one pop-up ever). All betting then routes through the relayer, signed locally — no more
 * pop-ups. Throws if there is no injected wallet (the caller should offer the guest burner instead).
 */
export async function connectSessionWallet(): Promise<Wallet> {
  const eth = injected();
  const provider = new BrowserProvider(eth);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const owner = (await signer.getAddress()).toLowerCase();

  const cacheKey = DERIVED_STORE_PREFIX + owner;
  let pk = lsGet(cacheKey);
  if (!pk) {
    // The one and only pop-up: a plain message signature — no gas, no transaction. Deterministic → stable identity.
    const signature = await signer.signMessage(SESSION_SIGN_MESSAGE);
    pk = sessionKeyFromSignature(signature);
    lsSet(cacheKey, pk);
  }
  return sessionWalletFrom(pk);
}

/**
 * A pure in-browser burner — no injected wallet needed. For visitors with no wallet, or who would
 * rather not sign. Persisted so a reload keeps the same guest identity (and its CHIP / positions).
 */
export function connectBurnerWallet(): Wallet {
  let pk = lsGet(BURNER_STORE_KEY);
  if (!pk) {
    pk = EthWallet.createRandom().privateKey;
    lsSet(BURNER_STORE_KEY, pk);
  }
  return sessionWalletFrom(pk);
}

/** Silently reconnect a previously-created guest burner if one is stored (null if none) — for a returning guest. */
export function restoreBurnerWallet(): Wallet | null {
  const pk = lsGet(BURNER_STORE_KEY);
  return pk ? sessionWalletFrom(pk) : null;
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
 * tx hash once mined so the caller can refresh the balance. When `gasless`, the faucet call is relayed
 * (no native 0G needed); falls back to a normal tx if the relayer is unavailable.
 */
export async function getTestTokens(wallet: Wallet, marketAddress = MARKET_ADDRESS, gasless = false): Promise<string> {
  const tokenAddr = await betTokenAddress(marketAddress);
  return withGasless(
    wallet,
    gasless,
    () => signAndRelay(wallet, tokenAddr, tokenIface.encodeFunctionData("faucet", [])),
    async () => {
      const signer = await wallet.provider.getSigner();
      const token = new Contract(tokenAddr, MOCK_BET_TOKEN_ABI, signer);
      const tx = await token.getFunction("faucet")();
      const receipt = await tx.wait();
      return receipt?.hash ?? tx.hash;
    },
  );
}

/**
 * Ensure the market is approved to pull at least `value` CHIP from the bettor. Approves MaxUint256
 * once if needed — relayed when `gasless`, else a normal approval tx. No-op if already approved.
 */
async function ensureApproval(market: string, wallet: Wallet, value: bigint, gasless: boolean): Promise<void> {
  const tokenAddr = await betTokenAddress(market);
  const token = new Contract(tokenAddr, MOCK_BET_TOKEN_ABI, wallet.provider);
  const allowance = (await token.getFunction("allowance")(wallet.account, market)) as bigint;
  if (allowance >= value) return;
  await withGasless(
    wallet,
    gasless,
    () => signAndRelay(wallet, tokenAddr, tokenIface.encodeFunctionData("approve", [market, MaxUint256])),
    async () => {
      const signer = await wallet.provider.getSigner();
      const t = new Contract(tokenAddr, MOCK_BET_TOKEN_ABI, signer);
      const approveTx = await t.getFunction("approve")(market, MaxUint256);
      await approveTx.wait();
      return approveTx.hash;
    },
  );
}

function readContract(address: string, wallet: Wallet) {
  return new Contract(address, MAFIA_MARKET_ABI, wallet.provider);
}

async function writeContract(address: string, wallet: Wallet) {
  const signer = await wallet.provider.getSigner();
  return new Contract(address, MAFIA_MARKET_ABI, signer);
}

// The faction market is now a normal categorical prop — there is no bespoke faction stake read or
// betYes/betNo. Wager on it via placePropBet, read the viewer's position via readMyPropStakes /
// readPropPositions (which cover every market), and claim/refund via claimPropPayout / refundPropStake.

/**
 * Place a wager on a categorical market by staking on ONE `outcome` (PlayerFate: a death-round bucket;
 * RoundVotedOut: a seat or "no one"; Faction: 0 = TOWN / 1 = MAFIA). Ensures the market is approved to
 * spend CHIP, then stakes via betProp. Returns the bet tx hash.
 */
export async function placePropBet(
  address: string,
  matchId: number,
  propIdx: number,
  wallet: Wallet,
  outcome: number,
  amount: string,
  gasless = false,
): Promise<string> {
  const value = parseEther(amount);
  await ensureApproval(address, wallet, value, gasless);
  return withGasless(
    wallet,
    gasless,
    () => signAndRelay(wallet, address, marketIface.encodeFunctionData("betProp", [matchId, propIdx, outcome, value])),
    async () => {
      const c = await writeContract(address, wallet);
      const tx = await c.getFunction("betProp")(matchId, propIdx, outcome, value);
      const receipt = await tx.wait();
      return receipt?.hash ?? tx.hash;
    },
  );
}

/** Claim a side-market payout/returned stake from a SETTLED match (RESOLVED pays the winner, VOID refunds). */
export async function claimPropPayout(address: string, matchId: number, propIdx: number, wallet: Wallet, gasless = false): Promise<string> {
  return withGasless(
    wallet,
    gasless,
    () => signAndRelay(wallet, address, marketIface.encodeFunctionData("claimProp", [matchId, propIdx])),
    async () => {
      const c = await writeContract(address, wallet);
      const tx = await c.getFunction("claimProp")(matchId, propIdx);
      const receipt = await tx.wait();
      return receipt?.hash ?? tx.hash;
    },
  );
}

/** Reclaim a side-market stake from a match in RefundMode (host never settled). */
export async function refundPropStake(address: string, matchId: number, propIdx: number, wallet: Wallet, gasless = false): Promise<string> {
  return withGasless(
    wallet,
    gasless,
    () => signAndRelay(wallet, address, marketIface.encodeFunctionData("refundProp", [matchId, propIdx])),
    async () => {
      const c = await writeContract(address, wallet);
      const tx = await c.getFunction("refundProp")(matchId, propIdx);
      const receipt = await tx.wait();
      return receipt?.hash ?? tx.hash;
    },
  );
}

/**
 * Collect EVERY listed winning market on a SETTLED match in ONE transaction — the "Claim all" primitive.
 * The contract skips indices the caller can't collect (already claimed / losing / out of range) and pays
 * the rest in a single transfer, so passing the full believed-winning set is safe even if some are stale.
 */
export async function batchClaimPayout(address: string, matchId: number, propIdxs: number[], wallet: Wallet, gasless = false): Promise<string> {
  return withGasless(
    wallet,
    gasless,
    () => signAndRelay(wallet, address, marketIface.encodeFunctionData("batchClaim", [matchId, propIdxs]), BATCH_RELAY_GAS),
    async () => {
      const c = await writeContract(address, wallet);
      const tx = await c.getFunction("batchClaim")(matchId, propIdxs);
      const receipt = await tx.wait();
      return receipt?.hash ?? tx.hash;
    },
  );
}

/** Reclaim EVERY listed stake on a RefundMode match in ONE transaction — the batch mirror of refundPropStake. */
export async function batchRefundStake(address: string, matchId: number, propIdxs: number[], wallet: Wallet, gasless = false): Promise<string> {
  return withGasless(
    wallet,
    gasless,
    () => signAndRelay(wallet, address, marketIface.encodeFunctionData("batchRefund", [matchId, propIdxs]), BATCH_RELAY_GAS),
    async () => {
      const c = await writeContract(address, wallet);
      const tx = await c.getFunction("batchRefund")(matchId, propIdxs);
      const receipt = await tx.wait();
      return receipt?.hash ?? tx.hash;
    },
  );
}

export interface MyPropStake {
  index: number;
  numOutcomes: number;
  /** The wallet's stake on each outcome (CHIP decimal strings), length == numOutcomes. */
  stakes: string[];
  claimed: boolean;
}

/**
 * Read the connected wallet's own per-outcome stake + claimed flag on each prop of a match.
 *
 * This is the LIVE holdings read behind the whole "Your book" / per-option position UI, and it re-runs
 * after every bet, on open and on settle — so it has to be both light and resilient. Two guards make it
 * so (mirroring the History position read, which had the same fan-out problem):
 *   1. Gate every eth_call through `readGate` and SKIP `propStake` for any outcome whose total pool is
 *      zero — nobody staked it, so the viewer's stake there is provably zero. getProp already hands back
 *      the pools, so this costs no extra call and collapses the fan-out from (props × outcomes) to just
 *      the outcomes that actually drew a bet.
 *   2. Read each market independently and swallow a single market's failure (a transient RPC hiccup)
 *      into a dropped entry, instead of letting one rejected call reject the whole `Promise.all` and
 *      wipe EVERY position to empty — the bug that made holdings silently vanish under RPC pressure.
 */
export async function readMyPropStakes(address: string, matchId: number, propCount: number, wallet: Wallet): Promise<MyPropStake[]> {
  const c = readContract(address, wallet);
  const results = await Promise.all(
    Array.from({ length: propCount }, async (_, i): Promise<MyPropStake | null> => {
      try {
        const pr = await readGate(() => c.getFunction("getProp")(matchId, i));
        const numOutcomes = Number(pr.numOutcomes);
        const pools = pr.pools as bigint[];
        const [claimed, stakeWeis] = await Promise.all([
          readGate(() => c.getFunction("propClaimed")(matchId, i, wallet.account) as Promise<boolean>),
          Promise.all(
            Array.from({ length: numOutcomes }, (_, o) =>
              (pools[o] ?? 0n) > 0n
                ? readGate(() => c.getFunction("propStake")(matchId, i, o, wallet.account) as Promise<bigint>)
                : Promise.resolve(0n),
            ),
          ),
        ]);
        return { index: i, numOutcomes, stakes: stakeWeis.map((s) => formatEther(s)), claimed };
      } catch {
        return null; // this market missed the refresh; the rest still surface, and it fills in next pass
      }
    }),
  );
  return results.filter((r): r is MyPropStake => r !== null);
}

/** A wallet's position on one side market of a past match, with the figures to size a claim. */
export interface PropPosition {
  index: number;
  kind: PropSnapshot["kind"];
  /** PLAYER_FATE: the seat. ROUND_VOTED_OUT / NIGHT_KILL: the 1-based round. */
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
 * Read the connected account's positions across EVERY market of a match — the headline FACTION market
 * and all the side markets — via the public provider (no wallet). Used by the History screen to detect
 * what the viewer wagered and surface any reclaimable pots. Safe to call on non-terminal matches too
 * (a zero-pool outcome is skipped, so an untouched market costs just its one getProp).
 */
export async function readPropPositions(address: string, matchId: number, account: string): Promise<PropPosition[]> {
  const c = new Contract(address, MAFIA_MARKET_ABI, readProvider());
  const count = Number((await readGate(() => c.getFunction("propCount")(matchId) as Promise<bigint>)));
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const pr = await readGate(() => c.getFunction("getProp")(matchId, i));
      const numOutcomes = Number(pr.numOutcomes);
      const pools = (pr.pools as bigint[]).map((p) => p);
      const state = PROP_STATE[Number(pr.state)];
      const base = {
        index: i,
        kind: PROP_KIND[Number(pr.kind)] ?? "PLAYER_FATE",
        param: Number(pr.param),
        numOutcomes,
        state,
        winningOutcome: state === "RESOLVED" ? Number(pr.winningOutcome) : undefined,
        netPot: formatEther(pr.netPot as bigint),
        winningPool: formatEther(pr.winningPool as bigint),
      };
      // An outcome with a zero total pool had no bets at all, so the viewer's stake there is provably
      // zero — skip the propStake read. A prop nobody touched costs just the one getProp above. This is
      // what keeps the per-match fan-out (and thus the failure surface) small on sparsely-bet markets.
      const hasAnyPool = pools.some((p) => p > 0n);
      if (!hasAnyPool) {
        return { ...base, stakes: pools.map(() => "0"), claimed: false };
      }
      const [claimed, stakeWeis] = await Promise.all([
        readGate(() => c.getFunction("propClaimed")(matchId, i, account) as Promise<boolean>),
        Promise.all(
          Array.from({ length: numOutcomes }, (_, o) =>
            (pools[o] ?? 0n) > 0n ? readGate(() => c.getFunction("propStake")(matchId, i, o, account) as Promise<bigint>) : Promise.resolve(0n),
          ),
        ),
      ]);
      return { ...base, stakes: stakeWeis.map((s) => formatEther(s)), claimed };
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
 * Flip an abandoned match (Created/Locked, past its settlement deadline) into RefundMode so its
 * stakes become refundable. Permissionless — normally the server does this automatically, but the
 * UI exposes it as a self-serve fallback. After this confirms, the bettor can call refundProp on
 * each market they staked.
 */
export async function enterRefundMode(address: string, matchId: number, wallet: Wallet, gasless = false): Promise<string> {
  return withGasless(
    wallet,
    gasless,
    () => signAndRelay(wallet, address, marketIface.encodeFunctionData("enterRefundMode", [matchId])),
    async () => {
      const c = await writeContract(address, wallet);
      const tx = await c.getFunction("enterRefundMode")(matchId);
      const receipt = await tx.wait();
      return receipt?.hash ?? tx.hash;
    },
  );
}

const MARKET_STATE: Record<number, MarketState> = { 2: "LOCKED", 3: "SETTLED", 4: "REFUND" };
/** MafiaMarket PropKind enum → wire label (0 PlayerFate, 1 RoundVotedOut, 2 NightKill, 3 DetectiveClaim, 4 MafiaSeat, 5 Faction). */
const PROP_KIND: Record<number, PropSnapshot["kind"]> = { 0: "PLAYER_FATE", 1: "ROUND_VOTED_OUT", 2: "NIGHT_KILL", 3: "DETECTIVE_CLAIM", 4: "MAFIA_SEAT", 5: "FACTION" };
/** The FACTION prop is opened FIRST at match start, right after createMatch's 2 base props (RoundVotedOut
 *  r1 at 0, NightKill r1 at 1), so it sits at index 2. (The per-seat PlayerFate/survival markets that used
 *  to precede it — making this `playerCount + 2` — are no longer floated; see myTasks.md.) */
const FACTION_PROP_INDEX = 2;
/** FACTION outcome index → winning faction. 1 = MAFIA wins (Acquitted), 0 = TOWN wins (Convicted). */
export const FACTION_OUTCOME = { TOWN: 0, MAFIA: 1 } as const;
/** MafiaMarket PropState enum → wire state (1 = Resolved, 2 = Void; 0 = Unset → undefined). */
const PROP_STATE: Record<number, PropSnapshot["state"]> = { 1: "RESOLVED", 2: "VOID" };

/** Public read-only provider — no wallet needed to read contract state. */
let publicProvider: JsonRpcProvider | null = null;
const readProvider = () => (publicProvider ??= new JsonRpcProvider(GALILEO.rpcUrl, GALILEO.chainId));

/**
 * Caps concurrent read-RPC so the public 0G node doesn't rate-limit a burst. Both the History position
 * reads (`readPropPositions`) and the live holdings read (`readMyPropStakes`) fan out over every market
 * prop × outcome — with the per-round RoundVotedOut markets that's ~80+ eth_calls per match — so without
 * a shared gate a scan floods the node and calls start failing. One module-level singleton means even
 * parallel match reads share the same budget.
 */
function makeLimiter(max: number) {
  let active = 0;
  const waiters: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiters.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
}
const readGate = makeLimiter(6);

export interface MarketRead {
  state: MarketState;
  /** Raw on-chain MatchState enum (0 None,1 Created,2 Locked,3 Settled,4 RefundMode). Lets callers
   *  distinguish Created vs. Locked, which both collapse to "OPEN"/"LOCKED" in `state`. */
  rawState: number;
  /** Block after which an unsettled match may be flipped to RefundMode. */
  settlementDeadlineBlock: number;
}

/**
 * Read the match's on-chain lifecycle state directly (no wallet). A liveness fallback: if the server
 * stops pushing — crashed mid-match, or someone moved the match into RefundMode after the deadline —
 * the client can still discover the terminal state and guide the bettor to claim/refund. Pools and
 * verdicts live in the props (read via readProps), not the Match struct.
 */
export async function readMarketState(address: string, matchId: number): Promise<MarketRead> {
  const c = new Contract(address, MAFIA_MARKET_ABI, readProvider());
  const m = await c.getFunction("matches")(matchId);
  return {
    state: MARKET_STATE[Number(m.state)] ?? "OPEN",
    rawState: Number(m.state),
    settlementDeadlineBlock: Number(m.settlementDeadlineBlock),
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

/** A past battle as the History screen lists it — the headline faction verdict, pot, and card bits. */
export interface MatchSummary extends MarketRead {
  matchId: number;
  playerCount: number;
  nonce: string;
  /** Headline FACTION market verdict, from its prop: RESOLVED (winner set) / VOID (mistrial) / undefined while unresolved. */
  factionState?: PropSnapshot["state"];
  /** The winning FACTION outcome when RESOLVED: 1 = MAFIA (Acquitted), 0 = TOWN (Convicted). */
  factionWinner?: number;
  /** Total staked on the FACTION market (CHIP decimal string) — the battle's headline pot. */
  pot: string;
  /** 0G Storage content root of the persona pool (evidence). ZeroHash when storage is off. */
  personaPoolRoot?: string;
  /** 0G Storage content root of the full attested transcript (evidence). ZeroHash until settled with storage on. */
  transcriptCID?: string;
}

/**
 * Read the headline FACTION prop for a match. It's opened first at match start, so it sits at the
 * deterministic index 2 (right after createMatch's 2 base props). Guarded: if that prop isn't the
 * faction market (a malformed/legacy match), the verdict is left unresolved with a zero pot.
 */
async function readFactionProp(
  c: Contract,
  matchId: number,
): Promise<{ state?: PropSnapshot["state"]; winner?: number; pot: string }> {
  try {
    const pr = await c.getFunction("getProp")(matchId, FACTION_PROP_INDEX);
    if (Number(pr.kind) !== 5) return { pot: "0" }; // not the FACTION prop → treat as unresolved
    const pot = formatEther((pr.pools as bigint[]).reduce((a, p) => a + p, 0n));
    const state = PROP_STATE[Number(pr.state)];
    return { state, winner: state === "RESOLVED" ? Number(pr.winningOutcome) : undefined, pot };
  } catch {
    return { pot: "0" };
  }
}

/** Read one match's summary (no wallet) for the History list. */
export async function readMatchSummary(matchId: number, address = MARKET_ADDRESS): Promise<MatchSummary> {
  const c = new Contract(address, MAFIA_MARKET_ABI, readProvider());
  const m = await c.getFunction("matches")(matchId);
  const playerCount = Number(m.playerCount);
  const faction = await readFactionProp(c, matchId);
  return {
    matchId,
    state: MARKET_STATE[Number(m.state)] ?? "OPEN",
    rawState: Number(m.state),
    settlementDeadlineBlock: Number(m.settlementDeadlineBlock),
    playerCount,
    nonce: m.nonce as string,
    factionState: faction.state,
    factionWinner: faction.winner,
    pot: faction.pot,
    // Both roots ride in the Match struct already read above — no extra call. Persona pool is set at
    // createMatch, transcript at settle; both are ZeroHash when the host runs with storage disabled.
    personaPoolRoot: m.personaPoolRoot as string,
    transcriptCID: m.transcriptCID as string,
  };
}
