/**
 * Display-name registry — the only place a wallet address maps to a human handle.
 *
 * Betting identities are anonymous wallet addresses (session keys / guest burners). The frontend gives
 * every address a deterministic pseudonym for free (see frontend lib/names.ts), but a player can claim a
 * custom handle in the lobby. For that handle to show on OTHER viewers' match leaderboards it must be
 * shared, so this tiny service holds the address→handle map and serves it to everyone.
 *
 * Anti-spoofing: anyone could otherwise POST a handle for someone else's address. So a set is SIGNED —
 * the owner signs `nameMessage(name)` with the same key it bets with (a session/guest key signs locally,
 * no pop-up) and we recover the signer and require it to equal the claimed address. Read is public.
 *
 * Routes (mounted by index.ts on the shared HTTP port, alongside /relay and /status):
 *   GET  /names?addresses=0x..,0x..  → { "0x..": "handle", ... }  (lowercased keys; only set ones)
 *   POST /names   body { address, name, signature }  → { ok, address, name }
 *
 * Persistence: a small JSON file (write-through), so handles survive a restart. Override the path with
 * NAMES_FILE; defaults to server/names.json (one level up from src/ or dist/, like the .env load).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getAddress, verifyMessage } from "ethers";

/** Max handle length — keeps the leaderboard legible and bounds storage. */
export const MAX_NAME_LEN = 24;

/**
 * The exact string the owner signs (and we verify) to claim a handle. MUST be byte-identical to the
 * frontend's builder (lib/names.ts → NAME_SET_MESSAGE) or the signature won't recover to the signer.
 */
export function nameMessage(name: string): string {
  return `Turing Pits — set my handle to "${name}"`;
}

/**
 * A handle is valid iff it's a non-empty, ≤MAX_NAME_LEN string with no surrounding whitespace and no
 * control characters. We reject rather than silently normalize so the string we store/verify is exactly
 * the one that was signed (any transform would break signature recovery).
 */
export function validateName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= MAX_NAME_LEN &&
    name === name.trim() &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

export interface NameRegistry {
  /** Try to handle an HTTP request; returns true if it owned the route (else the caller falls through). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** In-process lookup (lowercased address → handle), for tests / other server code. */
  get(address: string): string | undefined;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limitBytes = 8 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limitBytes) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export interface NameRegistryConfig {
  /** Where to persist the JSON map. Defaults to server/names.json (or $NAMES_FILE). */
  file?: string;
  /** Skip disk persistence entirely (used by tests). */
  ephemeral?: boolean;
}

function defaultFile(): string {
  return process.env.NAMES_FILE ?? resolve(dirname(fileURLToPath(import.meta.url)), "../names.json");
}

/**
 * Build the name registry. Always returns a working instance (unlike the optional relayer): a
 * deterministic pseudonym covers every address, and this just layers custom handles on top.
 */
export function createNameRegistry(cfg: NameRegistryConfig = {}): NameRegistry {
  const file = cfg.file ?? defaultFile();
  // Lowercased address → handle. Lowercasing the key means a lookup never depends on checksum casing.
  const names = new Map<string, string>();

  if (!cfg.ephemeral) {
    try {
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [addr, name] of Object.entries(parsed)) {
        if (validateName(name)) names.set(addr.toLowerCase(), name);
      }
      console.log(`[names] loaded ${names.size} handle(s) from ${file}`);
    } catch {
      /* no file yet (first run) or unreadable — start empty, it gets written on first set */
    }
  }

  const persist = () => {
    if (cfg.ephemeral) return;
    try {
      writeFileSync(file, JSON.stringify(Object.fromEntries(names), null, 0));
    } catch (e) {
      console.error("[names] failed to persist:", e);
    }
  };

  /** Validate + verify + store. Throws { status, message } on rejection. */
  function set(raw: unknown): { ok: true; address: string; name: string } {
    const body = raw as { address?: unknown; name?: unknown; signature?: unknown };
    if (typeof body?.address !== "string" || typeof body?.signature !== "string") {
      throw { status: 400, message: "expected { address, name, signature }" };
    }
    if (!validateName(body.name)) {
      throw { status: 400, message: `name must be 1–${MAX_NAME_LEN} chars, trimmed, no control characters` };
    }
    let address: string;
    try {
      address = getAddress(body.address);
    } catch {
      throw { status: 400, message: "malformed address" };
    }
    const name = body.name;
    // Recover the signer of nameMessage(name); it must be the address claiming the handle.
    let signer: string;
    try {
      signer = getAddress(verifyMessage(nameMessage(name), body.signature));
    } catch {
      throw { status: 400, message: "bad signature" };
    }
    if (signer !== address) throw { status: 401, message: "signature does not match address" };

    names.set(address.toLowerCase(), name);
    persist();
    return { ok: true, address, name };
  }

  return {
    get: (address) => names.get(address.toLowerCase()),
    async handle(req, res) {
      const url = (req.url ?? "").split("?")[0];
      if (url !== "/names") return false;

      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        res.end();
        return true;
      }

      if (req.method === "GET") {
        // ?addresses=a,b,c → the subset that has a custom handle. Missing/empty param → {}.
        const query = (req.url ?? "").split("?")[1] ?? "";
        const param = new URLSearchParams(query).get("addresses") ?? "";
        const wanted = param
          .split(",")
          .map((a) => a.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 500); // bound the fan-out
        const out: Record<string, string> = {};
        for (const addr of wanted) {
          const name = names.get(addr);
          if (name) out[addr] = name;
        }
        sendJson(res, 200, out);
        return true;
      }

      if (req.method === "POST") {
        try {
          const parsed = JSON.parse(await readBody(req));
          sendJson(res, 200, set(parsed));
        } catch (e: any) {
          const status = typeof e?.status === "number" ? e.status : 500;
          if (status >= 500) console.error("[names] error:", e);
          sendJson(res, status, { error: e?.message ?? "failed to set name" });
        }
        return true;
      }

      sendJson(res, 405, { error: "method not allowed" });
      return true;
    },
  };
}
