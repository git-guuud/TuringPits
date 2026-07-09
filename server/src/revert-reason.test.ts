import { describe, it, expect } from "vitest";
import { recoverMinedRevertReason, type ReplayProvider } from "./revert-reason.js";

// A mined status-0 CALL_EXCEPTION as ethers v6 throws it from tx.wait() — reason is null, the
// receipt is the only evidence. (Shape trimmed to the fields the recovery reads.)
const minedRevert = (over: object = {}) => ({
  code: "CALL_EXCEPTION",
  reason: null,
  receipt: { status: 0, hash: "0xabc", blockNumber: 43108550, ...over },
});

const tx = { from: "0xhost", to: "0xmarket", data: "0xdeadbeef" };

function fakeProvider(callImpl: ReplayProvider["call"]): ReplayProvider {
  return {
    getTransaction: async (hash) => (hash === "0xabc" ? tx : null),
    call: callImpl,
  };
}

describe("recoverMinedRevertReason", () => {
  it("recovers the reason by replaying at the parent block", async () => {
    let replayed: { from: string; to: null | string; data: string; blockTag: number } | undefined;
    const provider = fakeProvider(async (req) => {
      replayed = req;
      throw Object.assign(new Error("execution reverted"), { reason: "open in past" });
    });
    await expect(recoverMinedRevertReason(minedRevert(), provider)).resolves.toBe("open in past");
    expect(replayed).toEqual({ ...tx, blockTag: 43108549 }); // parent of the mined block
  });

  it("returns undefined for errors that are not mined status-0 reverts", async () => {
    const provider = fakeProvider(async () => {
      throw new Error("must not be called");
    });
    // estimateGas-style rejection: no receipt at all
    await expect(recoverMinedRevertReason({ code: "CALL_EXCEPTION", reason: "open in past" }, provider)).resolves.toBeUndefined();
    // successful receipt attached to some other failure
    await expect(recoverMinedRevertReason(minedRevert({ status: 1 }), provider)).resolves.toBeUndefined();
    await expect(recoverMinedRevertReason(new Error("timeout"), provider)).resolves.toBeUndefined();
  });

  it("returns undefined when the replay succeeds (reason lost to state drift)", async () => {
    const provider = fakeProvider(async () => "0x");
    await expect(recoverMinedRevertReason(minedRevert(), provider)).resolves.toBeUndefined();
  });

  it("returns undefined when the replay reverts without a decodable reason", async () => {
    const provider = fakeProvider(async () => {
      throw Object.assign(new Error("missing revert data"), { reason: null });
    });
    await expect(recoverMinedRevertReason(minedRevert(), provider)).resolves.toBeUndefined();
  });

  it("never throws — a broken provider still yields undefined", async () => {
    const provider: ReplayProvider = {
      getTransaction: async () => {
        throw new Error("rpc down");
      },
      call: async () => "0x",
    };
    await expect(recoverMinedRevertReason(minedRevert(), provider)).resolves.toBeUndefined();
  });

  it("returns undefined when the tx is no longer fetchable", async () => {
    const provider = fakeProvider(async () => "0x");
    await expect(
      recoverMinedRevertReason(minedRevert({ hash: "0xgone" }), provider),
    ).resolves.toBeUndefined();
  });
});
