import { describe, it, expect } from "vitest";
import { buildReasonPrompt, buildSpeechPrompt, buildDecisionPrompt, buildDiscussionPrompt } from "./prompt.js";
import type { TurnContext } from "./types.js";

const base: TurnContext = {
  persona: { seat: 2, name: "Ada", blurb: "a calculating analyst" },
  role: "TOWN",
  alive: [0, 1, 2, 3, 4],
  transcript: [
    [0, "I think seat 3 is suspicious."],
    [1, "Agreed, seat 3 was quiet."],
  ],
  decisionStub: { nonce: "deadbeef", phase: "day", round: 2, player: 2, action: "vote" },
  legalTargets: [0, 1, 3, 4],
};

const roster = [
  { seat: 0, name: "Ada", blurb: "a calm tactician" },
  { seat: 1, name: "Boris", blurb: "a loud accuser" },
  { seat: 2, name: "Cleo", blurb: "a peacemaker" },
  { seat: 3, name: "Dmitri", blurb: "a contrarian" },
  { seat: 4, name: "Esme", blurb: "a quiet strategist" },
];

const mafiaCtx: TurnContext = { ...base, role: "MAFIA", teammates: [4] };
const detectiveCtx: TurnContext = {
  ...base,
  role: "DETECTIVE",
  investigations: [{ round: 1, target: 1, faction: "MAFIA" }],
};

describe("buildReasonPrompt", () => {
  it("includes the public transcript and the legal targets", () => {
    const p = buildReasonPrompt(base);
    expect(p).toContain("seat 3 is suspicious");
    expect(p).toContain("0, 1, 3, 4");
  });

  it("asks for a JSON target+reason object", () => {
    const p = buildReasonPrompt(base).toLowerCase();
    expect(p).toContain('"target"');
    expect(p).toContain('"reason"');
  });

  it("gives MAFIA its teammates and a license to deceive", () => {
    const p = buildReasonPrompt(mafiaCtx);
    expect(p).toContain("4"); // teammate seat
    expect(p.toLowerCase()).toContain("lie");
  });

  it("does NOT give a town role any 'cover' / deception framing", () => {
    const p = buildReasonPrompt(base).toLowerCase();
    expect(p).not.toContain("cover");
    expect(p).not.toContain("lie");
  });

  it("gives DETECTIVE its own investigation results with the revealed alignment", () => {
    const p = buildReasonPrompt(detectiveCtx);
    expect(p).toContain("seat 1");
    expect(p).toContain("MAFIA");
  });
});

describe("buildSpeechPrompt", () => {
  it("tells the player its seat, name, and secret role", () => {
    const p = buildSpeechPrompt(base, 3, "seat 3 keeps dodging");
    expect(p).toContain("Ada");
    expect(p).toContain("TOWN");
    expect(p).toContain("seat 2");
  });

  it("narrates the actual chosen target and the private reason", () => {
    const p = buildSpeechPrompt(base, 3, "seat 3 keeps dodging");
    expect(p).toContain("seat 3");
    expect(p).toContain("seat 3 keeps dodging");
  });

  it("forbids parroting other players and self-accusation", () => {
    const p = buildSpeechPrompt(base, 3, "x").toLowerCase();
    expect(p).toContain("do not echo another player's wording");
    expect(p).toContain("yourself");
  });

  it("keeps deception-family words out of a TOWN speech prompt", () => {
    const p = buildSpeechPrompt(base, 3, "x").toLowerCase();
    expect(p).not.toContain("lie");
    expect(p).not.toContain("cover");
  });
});

describe("buildReasonPrompt — role heuristics & grounding", () => {
  it("forbids the DETECTIVE from voting a confirmed-town seat", () => {
    const ctx: TurnContext = {
      ...base, role: "DETECTIVE",
      investigations: [{ round: 1, target: 0, faction: "TOWN" }],
      decisionStub: { nonce: "deadbeef", phase: "day", round: 2, player: 2, action: "vote" },
    };
    const p = buildReasonPrompt(ctx);
    expect(p).toContain("FACTS YOU KNOW");
    expect(p.toLowerCase()).toContain("never vote a seat you have confirmed town");
  });

  it("tells the DETECTIVE not to re-investigate a known seat", () => {
    const ctx: TurnContext = {
      ...base, role: "DETECTIVE",
      decisionStub: { nonce: "deadbeef", phase: "night", round: 2, player: 2, action: "investigate" },
      legalTargets: [0, 1, 3, 4],
    };
    expect(buildReasonPrompt(ctx).toLowerCase()).toContain("not yet learned");
  });

  it("tells the DOCTOR to protect likely kill targets, not suspects", () => {
    const ctx: TurnContext = {
      ...base, role: "DOCTOR",
      decisionStub: { nonce: "deadbeef", phase: "night", round: 1, player: 2, action: "save" },
      legalTargets: [0, 1, 2, 3, 4],
    };
    const p = buildReasonPrompt(ctx).toLowerCase();
    expect(p).toContain("most wants dead");
    expect(p).toContain("not who seems guilty");
  });

  it("tells MAFIA to remove threats and spare teammates on a kill", () => {
    const ctx: TurnContext = {
      ...base, role: "MAFIA", teammates: [4],
      decisionStub: { nonce: "deadbeef", phase: "night", round: 1, player: 2, action: "kill" },
      legalTargets: [0, 1, 3, 4],
    };
    const p = buildReasonPrompt(ctx);
    expect(p).toContain("seat 4");
    expect(p.toLowerCase()).toContain("never target a teammate");
  });

  it("grounds an empty transcript as 'no evidence' and offers an honest 'no read' path", () => {
    const ctx: TurnContext = { ...base, transcript: [],
      decisionStub: { nonce: "deadbeef", phase: "night", round: 1, player: 2, action: "vote" } };
    const p = buildReasonPrompt(ctx).toLowerCase();
    expect(p).toContain("no behavioral evidence");
    expect(p).toContain("no read on them yet");
  });
});

describe("buildSpeechPrompt — claims", () => {
  it("lets a DETECTIVE choose to claim, naming the trade-off", () => {
    const ctx: TurnContext = { ...base, role: "DETECTIVE" };
    const p = buildSpeechPrompt(ctx, 3, "x").toLowerCase();
    expect(p).toContain("claim");
    expect(p).toContain("target");
  });

  it("lets MAFIA falsely claim a power role", () => {
    const ctx: TurnContext = { ...base, role: "MAFIA", teammates: [4] };
    expect(buildSpeechPrompt(ctx, 3, "x").toLowerCase()).toContain("falsely claim");
  });
});

describe("buildDecisionPrompt", () => {
  it("pins every fixed field and the chosen target into the skeleton", () => {
    const p = buildDecisionPrompt(base, 3);
    expect(p).toContain('"nonce":"deadbeef"');
    expect(p).toContain('"action":"vote"');
    expect(p).toContain('"target":3');
  });

  it("instructs the model to output only the decision string (no prose)", () => {
    const p = buildDecisionPrompt(base, 3).toLowerCase();
    expect(p).toContain("only");
  });
});

describe("buildDiscussionPrompt", () => {
  it("asks for a debate contribution reacting to a named player, no decision JSON", () => {
    const ctx: TurnContext = { ...base, role: "TOWN", stage: "discussion" };
    const p = buildDiscussionPrompt(ctx);
    expect(p.toLowerCase()).toContain("add one short, fresh point to the debate");
    expect(p).toContain("seat 3");        // grounded in the transcript ("seat 3 is suspicious")
    expect(p).not.toContain('"target"');  // free-form, not a decision
  });

  it("carries claim guidance so a DETECTIVE can choose to reveal", () => {
    const ctx: TurnContext = { ...base, role: "DETECTIVE", stage: "discussion" };
    expect(buildDiscussionPrompt(ctx).toLowerCase()).toContain("claim");
  });

  it("when no one has spoken yet, opens honestly and forbids specific accusations", () => {
    const ctx: TurnContext = { ...base, role: "TOWN", stage: "discussion", transcript: [] };
    const p = buildDiscussionPrompt(ctx).toLowerCase();
    expect(p).toContain("first to speak");
    expect(p).toContain("no information to judge anyone on yet");
    expect(p).toContain("do not accuse anyone of anything specific");
  });
});

describe("name-based addressing (roster present)", () => {
  const namedCtx: TurnContext = {
    ...base,
    persona: { seat: 2, name: "Cleo", blurb: "a peacemaker" },
    roster,
    transcript: [
      [0, "I have no read yet."],
      [1, "Watch the vote closely."],
      [2, "I agree, let's stay calm."],
    ],
  };

  it("renders the transcript and roster by name, not 'seat N'", () => {
    const p = buildDiscussionPrompt({ ...namedCtx, stage: "discussion" });
    expect(p).toContain("Ada: I have no read yet.");      // speaker shown by name
    expect(p).toContain("Cleo (you):");                    // own line marked
    expect(p).toContain("Players still in the game:");      // roster block
    expect(p.toLowerCase()).toContain('refer to people by name');
  });

  it("names the vote target in the speech while keeping the seat number for the decision JSON", () => {
    const speech = buildSpeechPrompt({ ...namedCtx, stage: "vote" }, 1, "x");
    expect(speech).toContain("vote in today's vote is for Boris"); // named target
    expect(speech).not.toContain("is for seat 1");

    const reason = buildReasonPrompt({ ...namedCtx, decisionStub: { ...base.decisionStub, player: 2 } });
    expect(reason).toContain("Boris (seat 1)"); // legal targets carry name + seat for JSON
    expect(reason.toLowerCase()).toContain("seat number");
  });
});

describe("game rules & forensics grounding", () => {
  it("explains the core Mafia mechanics in every public-facing prompt", () => {
    for (const p of [
      buildReasonPrompt(base),
      buildSpeechPrompt(base, 3, "x"),
      buildDiscussionPrompt({ ...base, stage: "discussion" }),
    ]) {
      const lc = p.toLowerCase();
      expect(lc).toContain("hidden-role");
      expect(lc).toContain("night");
      expect(lc).toContain("day");
      expect(lc).toContain("outnumber the town");
    }
  });

  it("tells players a kill is abstract — no weapon, method, or cause to analyze", () => {
    const lc = buildReasonPrompt(base).toLowerCase();
    expect(lc).toContain("no weapons");
    expect(lc).toContain("the only public fact is which seat is gone");
  });

  it("requires quoting a player's real words before drawing a conclusion", () => {
    const lc = buildReasonPrompt(base).toLowerCase();
    expect(lc).toContain("quote a player's actual words before drawing a conclusion");
  });

  it("does NOT itself name the 'tonight'/'silent' trigger words a weak model would echo", () => {
    // The grounding is stated positively; naming the bad words plants them in a weak model.
    const lc = buildReasonPrompt(base).toLowerCase();
    expect(lc).not.toContain("tonight");
    expect(lc).not.toContain("silent");
    expect(lc).not.toContain("aggressive");
  });
});

describe("self-reference & parroting guards", () => {
  it("marks the speaking seat's own lines in the transcript as '(you)'", () => {
    const ctx: TurnContext = {
      ...base,
      persona: { seat: 0, name: "Ada", blurb: "x" },
      role: "TOWN",
      transcript: [
        [0, "I opened the debate."],
        [1, "I think seat 3 is suspicious."],
      ],
    };
    expect(buildDiscussionPrompt({ ...ctx, stage: "discussion" })).toContain("seat 0 (you):");
  });

  it("tells the discussion to react to OTHER players by name, use own words, and not label lines", () => {
    const lc = buildDiscussionPrompt({ ...base, stage: "discussion" }).toLowerCase();
    expect(lc).toContain("other player");
    expect(lc).toContain('by name');
    expect(lc).toContain("do not prefix your line with a name label");
    expect(lc).toContain("your own words");
  });

  it("disarms the 'silence = guilt' trope: not-yet-spoken seats are just waiting their turn", () => {
    const lc = buildDiscussionPrompt({ ...base, stage: "discussion" }).toLowerCase();
    expect(lc).toContain("waiting for their turn");
    expect(lc).toContain("never call a player quiet, silent");
  });

  it("tells the speech to stay first-person and not rebut its own lines", () => {
    const lc = buildSpeechPrompt(base, 3, "x").toLowerCase();
    expect(lc).toContain("first person");
    expect(lc).toContain("your own lines");
  });
});

describe("phase framing & public death record (anti-hallucination grounding)", () => {
  it("a DAY prompt anchors to the day phase and the only-known fact (which seat is gone)", () => {
    const p = buildReasonPrompt(base).toLowerCase();
    expect(p).toContain("day phase");
    expect(p).toContain("which seat is now gone");
  });

  it("a NIGHT prompt frames the turn as private with no discussion", () => {
    const ctx: TurnContext = {
      ...base, role: "MAFIA", teammates: [4],
      decisionStub: { nonce: "deadbeef", phase: "night", round: 2, player: 2, action: "kill" },
    };
    const p = buildReasonPrompt(ctx).toLowerCase();
    expect(p).toContain("night phase");
    expect(p).toContain("in private");
    expect(p).toContain("no discussion");
  });

  it("forbids describing what anyone did during a night", () => {
    const p = buildReasonPrompt(base).toLowerCase();
    expect(p).toContain("never describe what anyone did during a night");
  });

  it("renders the public death record as ground-truth facts when seats have died", () => {
    const ctx: TurnContext = {
      ...base,
      deaths: [
        { round: 1, phase: "night", seat: 0 },
        { round: 1, phase: "day", seat: 1 },
      ],
    };
    const p = buildReasonPrompt(ctx);
    expect(p).toContain("WHAT HAS HAPPENED");
    expect(p).toContain("seat 0 was killed by the Mafia during the previous night");
    expect(p).toContain("seat 1 was voted out");
  });

  it("omits the death record entirely before anyone has died", () => {
    expect(buildReasonPrompt(base)).not.toContain("WHAT HAS HAPPENED");
  });
});
