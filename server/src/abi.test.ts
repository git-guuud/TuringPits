import { describe, expect, it } from "vitest";
import { marketStateOf, outcomeOf, winningSideOf } from "./abi.js";

// MatchState{None=0,Created=1,Locked=2,Settled=3,RefundMode=4}
// Outcome{Unset=0,Yes=1,No=2,Draw=3,Void=4}
// A wrong index here misdirects bettors about whether/how they reclaim — lock it down.
describe("contract enum mappings", () => {
  it("maps MatchState to the wire market state", () => {
    expect(marketStateOf(0)).toBe("OPEN"); // None
    expect(marketStateOf(1)).toBe("OPEN"); // Created
    expect(marketStateOf(2)).toBe("LOCKED");
    expect(marketStateOf(3)).toBe("SETTLED");
    expect(marketStateOf(4)).toBe("REFUND"); // RefundMode is NOT settled — reclaim via refund()
  });

  it("maps Outcome to the winning side (YES/NO only)", () => {
    expect(winningSideOf(1)).toBe("YES");
    expect(winningSideOf(2)).toBe("NO");
    expect(winningSideOf(3)).toBeUndefined(); // Draw
    expect(winningSideOf(4)).toBeUndefined(); // Void
    expect(winningSideOf(0)).toBeUndefined(); // Unset
  });

  it("maps Outcome to the full resolution incl. refund outcomes", () => {
    expect(outcomeOf(0)).toBeUndefined(); // Unset (unresolved)
    expect(outcomeOf(1)).toBe("YES");
    expect(outcomeOf(2)).toBe("NO");
    expect(outcomeOf(3)).toBe("DRAW");
    expect(outcomeOf(4)).toBe("VOID");
  });
});
