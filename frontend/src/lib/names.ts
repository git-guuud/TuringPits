/**
 * Display names for anonymous betting wallets — pure, no network.
 *
 * Every bettor is just an address. To make the match leaderboard read like people rather than a wall of
 * 0x-hashes, each address gets a DETERMINISTIC pseudonym here (same address → same handle, everywhere,
 * with no lookup). A player can override their own with a custom handle claimed in the lobby; those are
 * shared through the server (lib/contract.ts → fetchDisplayNames/setDisplayName) so other viewers see
 * them too. Resolution order for any address: shared custom handle → (for yourself) your locally-cached
 * pending handle → the pseudonym.
 *
 * The pseudonym pool is intentionally small and themed; collisions are possible, so the UI always shows
 * the short address alongside the name to disambiguate.
 */

/** Handle rules — mirrors the server's validateName so the lobby can give instant feedback. */
export const MAX_HANDLE_LEN = 24;
export function validHandle(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name.length >= 1 && name.length <= MAX_HANDLE_LEN && name === name.trim() && !/[\u0000-\u001f\u007f]/.test(name);
}

// Noir/courtroom-flavoured pool. Two 32-word lists → 1024 combos; the short address disambiguates ties.
const ADJECTIVES = [
  "Gilded", "Ashen", "Velvet", "Crimson", "Hollow", "Silent", "Iron", "Marble",
  "Wary", "Sable", "Amber", "Frayed", "Cobalt", "Ivory", "Dusk", "Ember",
  "Brass", "Quiet", "Onyx", "Pale", "Ragged", "Somber", "Umber", "Wicked",
  "Feral", "Gaunt", "Hushed", "Lurid", "Molten", "Nimble", "Rueful", "Stray",
];
const NOUNS = [
  "Fox", "Crow", "Mule", "Oracle", "Juror", "Knife", "Verdict", "Cipher",
  "Warden", "Magpie", "Gavel", "Lantern", "Sphinx", "Ferret", "Herald", "Mongrel",
  "Vandal", "Cutpurse", "Sentinel", "Rook", "Marionette", "Gambit", "Alibi", "Wraith",
  "Bishop", "Cardinal", "Drifter", "Envoy", "Fable", "Ghost", "Heretic", "Idol",
];

/** A tiny deterministic 32-bit hash (FNV-1a) over a string — stable across sessions/devices. */
function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The deterministic pseudonym for an address, e.g. "Gilded Fox". Case-insensitive on the address. */
export function pseudonymFor(address: string): string {
  const a = (address || "").toLowerCase();
  const adj = ADJECTIVES[fnv1a(a, 0x811c9dc5) % ADJECTIVES.length]!;
  const noun = NOUNS[fnv1a(a, 0x1000193) % NOUNS.length]!;
  return `${adj} ${noun}`;
}

/** A compact 0x1234…abcd for showing under the name. */
export function shortAddr(address: string): string {
  return address && address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

// ── Local optimistic cache of YOUR OWN claimed handle ─────────────────────────────────────────────
// Persisted per account so the lobby shows your edit instantly (and survives a reload) without waiting
// on a server round-trip. The server remains the source of truth for what OTHERS see.
const LOCAL_NAME_PREFIX = "turingpits.name.v1:";

export function getLocalName(account: string | null | undefined): string | null {
  if (!account) return null;
  try {
    return window.localStorage.getItem(LOCAL_NAME_PREFIX + account.toLowerCase());
  } catch {
    return null;
  }
}

export function setLocalName(account: string, name: string): void {
  try {
    window.localStorage.setItem(LOCAL_NAME_PREFIX + account.toLowerCase(), name);
  } catch {
    /* storage blocked — the name just won't persist locally; the server copy still drives others */
  }
}

export interface NameContext {
  /** Shared custom handles from the server, keyed by LOWERCASED address. */
  customNames: Record<string, string>;
  /** The connected wallet's address (for the "self" resolution + highlight), if any. */
  account?: string | null;
  /** The connected wallet's locally-cached pending handle (optimistic), if any. */
  myLocalName?: string | null;
}

export interface ResolvedName {
  name: string;
  /** This address is the connected wallet. */
  isSelf: boolean;
}

/** Resolve one address to its display name: shared custom → your local (self only) → pseudonym. */
export function resolveName(address: string, ctx: NameContext): ResolvedName {
  const key = address.toLowerCase();
  const isSelf = !!ctx.account && ctx.account.toLowerCase() === key;
  const custom = ctx.customNames[key];
  const name = custom ?? (isSelf && ctx.myLocalName ? ctx.myLocalName : undefined) ?? pseudonymFor(address);
  return { name, isSelf };
}
