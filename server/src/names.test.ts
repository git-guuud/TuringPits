import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import { createNameRegistry, nameMessage, validateName, MAX_NAME_LEN } from "./names.js";

describe("names — handle validation", () => {
  it("accepts a plain 1–24 char trimmed handle", () => {
    expect(validateName("Gilded Fox")).toBe(true);
    expect(validateName("a")).toBe(true);
    expect(validateName("x".repeat(MAX_NAME_LEN))).toBe(true);
  });

  it("rejects empty, overlong, untrimmed, non-string, or control-char handles", () => {
    expect(validateName("")).toBe(false);
    expect(validateName("x".repeat(MAX_NAME_LEN + 1))).toBe(false);
    expect(validateName(" leading")).toBe(false);
    expect(validateName("trailing ")).toBe(false);
    expect(validateName("line\nbreak")).toBe(false);
    expect(validateName(42 as unknown)).toBe(false);
    expect(validateName(undefined as unknown)).toBe(false);
  });
});

describe("names — signed set + public read", () => {
  const registry = createNameRegistry({ ephemeral: true });

  it("stores a handle when the signature recovers to the claimed address", async () => {
    const w = Wallet.createRandom();
    const name = "Ashen Mule";
    const signature = await w.signMessage(nameMessage(name));
    // set() is exercised through the same code path handle() uses; assert via the in-process getter.
    const res = await postName(registry, { address: w.address, name, signature });
    expect(res.status).toBe(200);
    expect(registry.get(w.address)).toBe(name);
    // Read is case-insensitive on the address.
    expect(registry.get(w.address.toLowerCase())).toBe(name);
  });

  it("rejects a handle signed for a DIFFERENT address (no impersonation)", async () => {
    const owner = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const name = "Impostor";
    // attacker signs, but claims the owner's address
    const signature = await attacker.signMessage(nameMessage(name));
    const res = await postName(registry, { address: owner.address, name, signature });
    expect(res.status).toBe(401);
    expect(registry.get(owner.address)).toBeUndefined();
  });

  it("rejects a signature over a DIFFERENT name than the one submitted", async () => {
    // The message is rebuilt from the SUBMITTED name, so a signature over another name recovers to a
    // different signer — the handle can't be swapped after signing. Rejected as a signer mismatch (401).
    const w = Wallet.createRandom();
    const signature = await w.signMessage(nameMessage("RealName"));
    const res = await postName(registry, { address: w.address, name: "SwappedName", signature });
    expect(res.status).toBe(401);
    expect(registry.get(w.address)).toBeUndefined();
  });

  it("rejects an invalid handle before touching the signature", async () => {
    const w = Wallet.createRandom();
    const signature = await w.signMessage(nameMessage("x".repeat(99)));
    const res = await postName(registry, { address: w.address, name: "x".repeat(99), signature });
    expect(res.status).toBe(400);
  });

  it("GET returns only the requested addresses that have a handle (lowercased keys)", async () => {
    const w = Wallet.createRandom();
    const name = "Velvet Crow";
    await postName(registry, { address: w.address, name, signature: await w.signMessage(nameMessage(name)) });
    const other = Wallet.createRandom().address;
    const body = await getNames(registry, [w.address, other]);
    expect(body[w.address.toLowerCase()]).toBe(name);
    expect(body[other.toLowerCase()]).toBeUndefined();
  });
});

// ── tiny in-memory HTTP harness so we exercise the real handle() route logic ──

interface FakeRes {
  status: number;
  body: string;
  writeHead(status: number): FakeRes;
  end(body?: string): void;
}
function fakeRes(): FakeRes {
  return {
    status: 0,
    body: "",
    writeHead(status: number) {
      this.status = status;
      return this;
    },
    end(body = "") {
      this.body += body;
    },
  };
}

async function postName(registry: ReturnType<typeof createNameRegistry>, payload: unknown): Promise<{ status: number; body: any }> {
  const chunks = JSON.stringify(payload);
  const req: any = {
    url: "/names",
    method: "POST",
    _listeners: {} as Record<string, (arg?: unknown) => void>,
    on(event: string, cb: (arg?: unknown) => void) {
      this._listeners[event] = cb;
      // Drive the stream synchronously on the next tick after both handlers are attached.
      if (event === "end") {
        queueMicrotask(() => {
          this._listeners.data?.(chunks);
          this._listeners.end?.();
        });
      }
      return this;
    },
  };
  const res = fakeRes();
  await registry.handle(req, res as any);
  return { status: res.status, body: res.body ? JSON.parse(res.body) : undefined };
}

async function getNames(registry: ReturnType<typeof createNameRegistry>, addresses: string[]): Promise<Record<string, string>> {
  const req: any = { url: `/names?addresses=${addresses.join(",")}`, method: "GET", on: () => req };
  const res = fakeRes();
  await registry.handle(req, res as any);
  return JSON.parse(res.body);
}
