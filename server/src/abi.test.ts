import { describe, expect, it } from "vitest";
import { marketStateOf, propStateOf } from "./abi.js";

// MatchState{None=0,Created=1,Locked=2,Settled=3,RefundMode=4}
// PropState{Unset=0,Resolved=1,Void=2} — EVERY market (headline faction included) resolves via this.
// A wrong index here misdirects bettors about whether/how they reclaim — lock it down.
describe("contract enum mappings", () => {
  it("maps MatchState to the wire market state", () => {
    expect(marketStateOf(0)).toBe("OPEN"); // None
    expect(marketStateOf(1)).toBe("OPEN"); // Created
    expect(marketStateOf(2)).toBe("LOCKED");
    expect(marketStateOf(3)).toBe("SETTLED");
    expect(marketStateOf(4)).toBe("REFUND"); // RefundMode is NOT settled — reclaim via refundProp()
  });

  it("maps PropState to the wire prop state (drives every market's verdict incl. the faction verdict)", () => {
    expect(propStateOf(0)).toBeUndefined(); // Unset (unresolved)
    expect(propStateOf(1)).toBe("RESOLVED"); // a winning outcome — its backers split the pot
    expect(propStateOf(2)).toBe("VOID"); // nobody backed the winner / a mistrial → full refund
  });
});
