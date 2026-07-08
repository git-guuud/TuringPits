/**
 * The real contract layer (v3 multi-match MafiaMarket). Connects an injected wallet to the
 * deployed contract on 0G Galileo and performs the only on-chain actions a spectator takes for
 * a given `matchId`: stake on a market outcome (betProp), claim/refund (claimProp/refundProp),
 * and read their own stake. EVERY market — the headline faction market included — is a categorical
 * prop. Pool sizes / market state arrive over the WebSocket (the server reads them from this same
 * contract), so this module stays narrow.
 */
import { BrowserProvider, Contract, Interface, JsonRpcProvider, MaxUint256, Wallet as EthWallet, formatEther, getAddress, keccak256, parseEther } from "ethers";
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Display-name registry (the match leaderboard's names). Bettors are anonymous addresses; the
// frontend gives each a deterministic pseudonym (lib/names.ts), and a player can claim a custom
// handle in the lobby. Custom handles are shared via the server's /names route so OTHER viewers see
// them; a set is SIGNED (server verifies the signer == the address) so nobody can rename anyone else.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The exact message signed to claim a handle. MUST byte-match the server's `nameMessage` (names.ts). */
export const NAME_SET_MESSAGE = (name: string) => `Turing Pits — set my handle to "${name}"`;

/**
 * Fetch the custom handles for a set of addresses (lowercased-address → handle). Only addresses that
 * have claimed a handle appear; the caller fills the rest with a deterministic pseudonym. Best-effort:
 * returns {} on any failure so the leaderboard still renders (with pseudonyms).
 */
export async function fetchDisplayNames(addresses: string[]): Promise<Record<string, string>> {
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()))];
  if (uniq.length === 0) return {};
  try {
    const r = await fetch(`${resolveRelayBase()}/names?addresses=${encodeURIComponent(uniq.join(","))}`);
    return r.ok ? ((await r.json()) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Claim a custom handle for the connected wallet. The wallet's in-browser session key signs the
 * name message LOCALLY (no pop-up) — an injected signer would prompt, but connected identities here
 * are always session/guest keys — and the server verifies the signature before storing. Throws a
 * friendly line on rejection (e.g. an invalid handle).
 */
export async function setDisplayName(wallet: Wallet, name: string): Promise<void> {
  const signer = wallet.session ?? (await wallet.provider.getSigner());
  const signature = await signer.signMessage(NAME_SET_MESSAGE(name));
  const res = await fetch(`${resolveRelayBase()}/names`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: wallet.account, name, signature }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't save your handle — try a different one.");
  }
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
 * Known on-chain revert reasons — the exact `require(...)` strings the contracts throw
 * (MafiaMarket.sol / MockBetToken.sol / Forwarder.sol) — mapped to plain-language bettor copy.
 * Every ordered entry is a [substring-to-match, friendly-line]; first hit wins, so keep the more
 * specific reasons above the generic ones. This is the allow-list that lets a decoded reason
 * through: anything NOT here is treated as an opaque failure and never shown verbatim.
 */
const REVERT_COPY: ReadonlyArray<readonly [string, string]> = [
  ["insufficient allowance", "Approval needed — confirm the token approval, then place your wager again."],
  ["insufficient balance", "Not enough CHIP — tap “Get test CHIP” to mint more, then try again."],
  ["below min bet", "That wager is below the minimum stake — raise it and try again."],
  ["above max bet", "That wager is above the per-bet maximum — lower it and try again."],
  ["betting not started", "Wagers haven't opened yet — hold on a moment."],
  ["betting closed", "Wagers just closed for this market."],
  ["betting locked", "Wagers just closed for this market."],
  ["betting still open", "Wagers are still open — that action isn't available yet."],
  ["deadline passed", "Wagers just closed for this market."],
  ["prop closed", "This market is closed — no more wagers on it."],
  ["bad outcome", "That pick isn't valid for this market — choose again."],
  ["already opened", "That market is already open."],
  ["nothing to claim", "Nothing to claim on this wallet."],
  ["nothing to refund", "Nothing to reclaim on this wallet."],
  ["already claimed", "You've already claimed this — nothing left to collect."],
  ["already refunded", "You've already reclaimed this stake."],
  ["no winning stake", "No winnings to claim on this market."],
  ["no stake", "You have no stake on this market."],
  ["not settled", "This match hasn't settled yet — check back once the verdict is in."],
  ["not settleable", "This match can't be settled right now."],
  ["not refundable", "This match can't be refunded right now."],
  ["not refund mode", "This match isn't open for refunds yet."],
  ["deadline not passed", "Too early to reclaim — the settlement window hasn't closed yet."],
  ["not lockable", "This match can't be locked right now."],
  ["request expired", "This wager request expired — place it again."],
  ["invalid or expired signature", "This wager request expired — place it again."],
  ["rate limit", "Slow down a moment — one wager at a time, then try again."],
  ["already in flight", "A wager is still going through — give it a second, then try again."],
  ["transfer failed", "The token transfer didn't go through — try again in a moment."],
];

/**
 * Pull the on-chain revert reason out of whatever shape ethers / the relayer handed us. The reason
 * can live in a clean `reason` field, be quoted inside `shortMessage` ("execution reverted: \"betting
 * closed\""), or be buried in a nested RPC error. Returns a lowercased haystack of every place it
 * might be — callers substring-match `REVERT_COPY` against it.
 */
function revertHaystack(err: {
  reason?: string;
  shortMessage?: string;
  message?: string;
  data?: { message?: string };
  error?: { message?: string; reason?: string };
  info?: { error?: { message?: string } };
}): string {
  return [
    err?.reason,
    err?.shortMessage,
    err?.error?.reason,
    err?.error?.message,
    err?.data?.message,
    err?.info?.error?.message,
    err?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Turn a raw wallet/ethers/relayer error into a single plain-language line for the bettor. Raw
 * chain errors are verbose and scary ("user rejected action (action=…)", CALL_EXCEPTION blobs,
 * "missing revert data", ABI-encoded custom-error hex) — none of that ever reaches the UI. We map
 * wallet codes and the contracts' known revert reasons to friendly copy; anything unrecognized
 * collapses to a generic line, with the raw error kept ONLY in the console for debugging.
 */
export function humanizeTxError(e: unknown): string {
  const err = (e ?? {}) as {
    code?: string | number;
    reason?: string;
    shortMessage?: string;
    message?: string;
    data?: { message?: string };
    error?: { message?: string; reason?: string };
    info?: { error?: { message?: string } };
  };
  const code = err?.code;
  const raw = revertHaystack(err);

  // Log the real error so hiding it from the UI never costs us debuggability.
  if (e) console.error("[tx] humanized error →", e);

  // ── Wallet / provider-level conditions (not contract reverts) ────────────────────────────────
  if (code === "ACTION_REJECTED" || code === 4001 || raw.includes("user rejected") || raw.includes("user denied")) {
    return "Wager cancelled.";
  }
  if (code === "INSUFFICIENT_FUNDS" || raw.includes("insufficient funds")) {
    return "Not enough 0G for gas — top up from the faucet (faucet.0g.ai) and try again.";
  }
  if (raw.includes("no wallet found")) {
    return "No wallet found — install MetaMask, or tap “Play as guest” to bet with a browser wallet.";
  }
  if (raw.includes("relayer") && (raw.includes("out of gas") || raw.includes("offline"))) {
    return "The gas relayer is offline right now — try again in a moment, or connect your own wallet.";
  }
  if (raw.includes("wrong network") || raw.includes("unsupported chain") || raw.includes("chainid")) {
    return "Wrong network — switch your wallet to 0G Galileo.";
  }

  // ── Known contract revert reasons ────────────────────────────────────────────────────────────
  for (const [needle, copy] of REVERT_COPY) {
    if (raw.includes(needle)) return copy;
  }

  // ── Anything else: a generic, non-scary line. Never surface the raw revert/blob text. ────────
  if (raw.includes("revert") || raw.includes("call_exception") || raw.includes("cannot estimate gas")) {
    return "That transaction was rejected on-chain — it may no longer be valid. Refresh and try again.";
  }
  if (code === "TIMEOUT" || raw.includes("timeout") || raw.includes("network error") || raw.includes("failed to fetch")) {
    return "Network hiccup — check your connection and try again.";
  }
  return "Something went wrong with that transaction — please try again.";
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

/** A raw prop tuple as returned by getProp/getProps/getUserMatch (same leading field order). */
type RawProp = {
  kind: bigint | number;
  param: bigint | number;
  numOutcomes: bigint | number;
  closed: boolean;
  state: bigint | number;
  winningOutcome: bigint | number;
  netPot: bigint;
  winningPool: bigint;
  pools: bigint[];
  stakes?: bigint[]; // present only on getUserMatch
  claimed?: boolean; // present only on getUserMatch
};

/** Decode a prop tuple → PropSnapshot (the market's public state). Shared by readProps + getProps. */
function toPropSnapshot(pr: RawProp, index: number): PropSnapshot {
  const state = PROP_STATE[Number(pr.state)];
  return {
    index,
    kind: PROP_KIND[Number(pr.kind)] ?? "PLAYER_FATE",
    param: Number(pr.param),
    numOutcomes: Number(pr.numOutcomes),
    pools: pr.pools.map((p) => formatEther(p)),
    closed: Boolean(pr.closed),
    state,
    winningOutcome: state === "RESOLVED" ? Number(pr.winningOutcome) : undefined,
  };
}

/** Decode a getUserMatch view → PropPosition (public state + the viewer's per-outcome stakes/claimed). */
function toPropPosition(uv: RawProp, index: number): PropPosition {
  const state = PROP_STATE[Number(uv.state)];
  return {
    index,
    kind: PROP_KIND[Number(uv.kind)] ?? "PLAYER_FATE",
    param: Number(uv.param),
    numOutcomes: Number(uv.numOutcomes),
    state,
    winningOutcome: state === "RESOLVED" ? Number(uv.winningOutcome) : undefined,
    netPot: formatEther(uv.netPot),
    winningPool: formatEther(uv.winningPool),
    stakes: (uv.stakes ?? []).map((s) => formatEther(s)),
    claimed: Boolean(uv.claimed),
  };
}

/** Market addresses (lowercased) proven to predate the batch getters — probe once, then always go legacy. */
const legacyMarkets = new Set<string>();

/**
 * True when `err` is the "this function doesn't exist on this contract" signature — i.e. an OLD market
 * deployment that predates the batch getters. On 0G a missing selector reverts data-lessly as
 * "execution reverted (no data present; likely require(false))"; ethers may also surface it as a decode
 * failure. Deliberately NOT matched: "missing revert data", the DISTINCT string 0G uses for transient
 * load-shedding (see isTransientReadError) — that's a healthy contract under pressure, not a missing
 * getter, and must never be cached as legacy.
 */
function isMissingSelector(err: unknown): boolean {
  const e = err as { shortMessage?: string; message?: string };
  const msg = `${e?.shortMessage ?? ""} ${e?.message ?? ""}`;
  return /no data present|require\(false\)|could not decode result data|unsupported method|method not found/i.test(msg);
}

/**
 * Run `batch` (the single-call fast path) and, on failure, fall back to `legacy` (the per-call fan-out).
 * The batch call is already retried on transient overload by readGate, so a failure here is almost always
 * an older deployment lacking the getter — which we remember per `marketAddr` so every later read skips
 * the doomed probe and goes straight to legacy (no added RPC load on old contracts). New deployments
 * answer the batch call and never touch the fallback.
 */
async function batchOrLegacy<T>(marketAddr: string, batch: () => Promise<T>, legacy: () => Promise<T>): Promise<T> {
  const key = marketAddr.toLowerCase();
  if (legacyMarkets.has(key)) return legacy();
  try {
    return await batch();
  } catch (err) {
    if (isMissingSelector(err)) legacyMarkets.add(key); // old deployment — don't probe it again this session
    return legacy();
  }
}

/**
 * Read the connected wallet's own per-outcome stake + claimed flag on each prop of a match — the LIVE
 * holdings read behind the "Your book" / per-option position UI. It re-runs after every bet, on open and
 * on settle, so it stays light: ONE getUserMatch call returns every market's numOutcomes + the wallet's
 * stakes + claimed in a single round-trip. `propCount` is retained for the legacy fallback's fan-out.
 */
export async function readMyPropStakes(address: string, matchId: number, propCount: number, wallet: Wallet): Promise<MyPropStake[]> {
  const c = readContract(address, wallet);
  return batchOrLegacy(
    address,
    async () => {
      const views = (await readGate(() => c.getFunction("getUserMatch")(matchId, wallet.account))) as RawProp[];
      return views.map((uv, i): MyPropStake => ({
        index: i,
        numOutcomes: Number(uv.numOutcomes),
        stakes: (uv.stakes ?? []).map((s) => formatEther(s)),
        claimed: Boolean(uv.claimed),
      }));
    },
    () => readMyPropStakesLegacy(c, matchId, propCount, wallet),
  );
}

/**
 * Pre-batch-getter fallback for readMyPropStakes on OLD market deployments: a per-market fan-out, each
 * market read independently so one market's transient failure drops just that entry (not the whole book),
 * and zero-pool outcomes skip their propStake read (the viewer's stake there is provably zero).
 */
async function readMyPropStakesLegacy(c: Contract, matchId: number, propCount: number, wallet: Wallet): Promise<MyPropStake[]> {
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
 * Read an account's positions across EVERY market of a match — the headline FACTION market and all the
 * side markets — via the public provider (no wallet). Used by the History screen to detect what the
 * viewer wagered and by the leaderboard's legacy path. ONE getUserMatch call returns every market plus
 * this account's per-outcome stakes and claimed flags; the fallback is the old per-market fan-out.
 */
export async function readPropPositions(address: string, matchId: number, account: string): Promise<PropPosition[]> {
  const c = new Contract(address, MAFIA_MARKET_ABI, readProvider());
  return batchOrLegacy(
    address,
    async () => {
      const views = (await readGate(() => c.getFunction("getUserMatch")(matchId, account))) as RawProp[];
      return views.map((uv, i) => toPropPosition(uv, i));
    },
    () => readPropPositionsLegacy(c, matchId, account),
  );
}

/**
 * Pre-batch-getter fallback for readPropPositions on OLD market deployments. Reads propCount, then each
 * market's getProp; a zero-pool outcome skips its propStake read (the account's stake there is provably
 * zero), so an untouched market costs just its one getProp.
 */
async function readPropPositionsLegacy(c: Contract, matchId: number, account: string): Promise<PropPosition[]> {
  const count = Number(await readGate(() => c.getFunction("propCount")(matchId) as Promise<bigint>));
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

/** One wallet's realized result on a terminal match — the leaderboard row before naming/ranking. */
export interface MatchNet {
  address: string;
  /** Total CHIP wagered across every market. */
  staked: number;
  /** Gross CHIP returned (winning payouts + Void/refund returns), == what claim/batchClaim would pay. */
  returned: number;
  /** Net profit (returned − staked). */
  net: number;
}

/**
 * The realized (staked, returned, net) for a list of wallets on a match — the ENTIRE leaderboard in a
 * single call (chunked only to bound one call's return size on a huge field). `returned` is computed
 * on-chain with the same arithmetic claimProp/batchClaim pay, so a board figure is the exact collectable
 * amount. Throws if the deployment predates getUserMatchNets (the leaderboard then falls back per-bettor).
 */
export async function readMatchNets(address: string, matchId: number, users: string[]): Promise<MatchNet[]> {
  if (users.length === 0) return [];
  // Share the legacy-market cache with the other batch readers: if this deployment is already known to
  // predate the getters, don't probe it — throw straight to the leaderboard's per-bettor fallback.
  if (legacyMarkets.has(address.toLowerCase())) throw new Error("legacy market: getUserMatchNets unavailable");
  const c = new Contract(address, MAFIA_MARKET_ABI, readProvider());
  const CHUNK = 100;
  const out: MatchNet[] = [];
  try {
    for (let i = 0; i < users.length; i += CHUNK) {
      const chunk = users.slice(i, i + CHUNK);
      const nets = (await readGate(() => c.getFunction("getUserMatchNets")(matchId, chunk))) as { staked: bigint; returned: bigint }[];
      nets.forEach((n, k) => {
        const staked = parseFloat(formatEther(n.staked));
        const returned = parseFloat(formatEther(n.returned));
        out.push({ address: chunk[k]!, staked, returned, net: returned - staked });
      });
    }
  } catch (err) {
    if (isMissingSelector(err)) legacyMarkets.add(address.toLowerCase()); // old deployment — remember it
    throw err;
  }
  return out;
}

/**
 * Enumerate every wallet that wagered on a match — the leaderboard roster. `propStake` is a mapping
 * keyed by a known address (not iterable), so the only way to discover WHO bet is the PropBetPlaced
 * event. Both `matchId` and `user` are indexed, so this is a cheap topic-filtered getLogs, bounded to
 * the match's lifetime via its MatchCreated block (confirmed to work full-range on 0G, but bounding
 * keeps it fast). Returns unique checksummed addresses in first-seen order.
 */
export async function readMatchBettors(matchId: number, address = MARKET_ADDRESS): Promise<string[]> {
  const c = new Contract(address, MAFIA_MARKET_ABI, readProvider());
  // Bound the scan to the match's creation block → head. Best-effort: a full-range topic query works
  // on 0G, so if this lookup fails we still get the right logs, just over a wider range.
  let fromBlock = 0;
  try {
    const created = await c.queryFilter(c.filters.MatchCreated!(matchId));
    if (created.length > 0) fromBlock = created[0]!.blockNumber;
  } catch {
    /* leave fromBlock=0 */
  }
  const logs = await c.queryFilter(c.filters.PropBetPlaced!(matchId), fromBlock);
  const seen = new Set<string>();
  const bettors: string[] = [];
  for (const log of logs) {
    const user = (log as { args?: { user?: string } }).args?.user;
    if (!user) continue;
    const checksum = getAddress(user);
    const key = checksum.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      bettors.push(checksum);
    }
  }
  return bettors;
}

/**
 * Read the side markets for a match from the contract (no wallet) — a fallback for when the server
 * isn't pushing `props` over the WebSocket (e.g. the History screen, or a crashed server). ONE getProps
 * call returns the whole array; the fallback is the old propCount-wide getProp fan-out.
 */
export async function readProps(address: string, matchId: number): Promise<PropSnapshot[]> {
  const c = new Contract(address, MAFIA_MARKET_ABI, readProvider());
  return batchOrLegacy(
    address,
    async () => {
      const raw = (await readGate(() => c.getFunction("getProps")(matchId))) as RawProp[];
      return raw.map((pr, i) => toPropSnapshot(pr, i));
    },
    async () => {
      const count = Number((await readGate(() => c.getFunction("propCount")(matchId))) as bigint);
      return Promise.all(
        Array.from({ length: count }, async (_, i) => {
          const pr = (await readGate(() => c.getFunction("getProp")(matchId, i))) as RawProp;
          return toPropSnapshot(pr, i);
        }),
      );
    },
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * True only for TRANSIENT node/overload failures worth retrying — NOT genuine contract reverts. When the
 * public 0G node sheds a read under load it answers with a data-less `missing revert data` (ethers code
 * CALL_EXCEPTION, no revert payload); a real `require`/`revert` instead carries data ("execution reverted:
 * <reason>"). We must retry the former and never the latter, so match the overload signatures explicitly
 * and leave everything with actual revert data to propagate. Also covers plain network/server hiccups.
 */
function isTransientReadError(err: unknown): boolean {
  const e = err as { code?: string; shortMessage?: string; message?: string; info?: { error?: { message?: string } } };
  if (e?.code === "SERVER_ERROR" || e?.code === "TIMEOUT" || e?.code === "NETWORK_ERROR") return true;
  const msg = `${e?.shortMessage ?? ""} ${e?.message ?? ""} ${e?.info?.error?.message ?? ""}`;
  return /missing revert data|could not coalesce|rate.?limit|too many requests|\b429\b|\b503\b|service unavailable|econnreset|failed to fetch|network error/i.test(
    msg,
  );
}

/**
 * Retry a read on transient 0G overload with exponential backoff + jitter. Runs INSIDE the concurrency
 * slot (see readGate) so the slot is held across the wait — a struggling node isn't re-flooded while we
 * back off, which is what lets a burst actually drain instead of collapsing. Genuine reverts throw on the
 * first try (isTransientReadError == false), so this never masks a real contract error.
 */
async function withReadRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientReadError(err)) throw err;
      last = err;
      await sleep(120 * 2 ** attempt + Math.random() * 120);
    }
  }
  throw last;
}

const rawReadGate = makeLimiter(6);
/**
 * The single choke point for read-RPC: caps concurrency AND retries transient node overload. Before this,
 * a large fan-out (e.g. the match leaderboard reading every bettor's position — ~300 eth_calls) tripped
 * 0G's load-shedding, and each shed `missing revert data` rejected a whole bettor's `Promise.all`, so the
 * board silently came back empty ("No wagers were placed"). Retrying the shed reads here fixes that for
 * every fan-out (leaderboard, History, live holdings) with no change at the call sites.
 */
const readGate = <T>(fn: () => Promise<T>): Promise<T> => rawReadGate(() => withReadRetry(fn));

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
