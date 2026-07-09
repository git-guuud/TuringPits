import { describe, it, expect } from "vitest";
import { buildReasonPrompt, buildSpeechPrompt, buildDecisionPrompt, buildDiscussionPrompt, buildVoteSpeechPrompt, recentTranscript, TRANSCRIPT_MAX_ENTRIES, SPEECH_MAX_WORDS } from "./prompt.js";
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
    // Legal targets are present (natural seat order now the display shuffle is gone); assert the SET.
    const seats = p.match(/Legal target seats: ([^\n.]+)/)![1]!.match(/\d+/g)!.map(Number).sort((a, b) => a - b);
    expect(seats).toEqual([0, 1, 3, 4]);
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
  it("asks for a grounded, present-tense debate contribution, no decision JSON", () => {
    const ctx: TurnContext = { ...base, role: "TOWN", stage: "discussion" };
    const p = buildDiscussionPrompt(ctx);
    expect(p.toLowerCase()).toContain("in your own words");
    expect(p.toLowerCase()).toContain('"today", not "tonight"');
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
    expect(p).toContain("you speak first");
    expect(p).toContain("there is no behaviour to judge");
    expect(p).toContain("don't invent behaviour for anyone");
  });

  it("folds self-defense into the open reactor as a static clause (no forced underFire branch)", () => {
    // The separate underFire branch is gone; the open task always carries the anti-self-railroad clause,
    // so an accused seat fights back without the model being told, per seat, that it is under fire.
    const ctx: TurnContext = {
      ...base, roster,
      persona: { seat: 2, name: "Cleo", blurb: "a peacemaker" },
      transcript: [[0, "I suspect Cleo is hiding something — let's vote her out today."]],
    };
    const p = buildDiscussionPrompt(ctx);
    expect(p).toContain("If the table is turning on YOU, defend yourself");
    expect(p).toContain("never agree to your own removal");
  });

  it("a Detective with only cleared-Town results vouches instead of accusing them", () => {
    const ctx: TurnContext = {
      ...base, roster, role: "DETECTIVE",
      investigations: [{ round: 1, target: 1, faction: "TOWN" }], // Boris privately cleared
    };
    const p = buildDiscussionPrompt(ctx);
    expect(p).toContain("CLEARED Boris");
    expect(p).toContain("NEVER accuse or push the vote onto Boris");
    expect(p).not.toContain("move today's vote forward"); // not the generic accuse-someone reactor task
  });

  it("makes a Detective's claim ALL-OR-NOTHING — a full explicit claim or no hint at all", () => {
    // Live failure this pins down: the Detective half-revealed most rounds ("X is town, I checked")
    // without ever saying it is the Detective — too vague to convince the table AND invisible to
    // claimsDetective (so the claim beat/market never fired). The guidance + cleared-Town branch now
    // demand either the full claim (role, target, result) or complete silence about secret knowledge.
    const ctx: TurnContext = {
      ...base, roster, role: "DETECTIVE",
      investigations: [{ round: 1, target: 1, faction: "TOWN" }],
    };
    const p = buildDiscussionPrompt(ctx);
    expect(p).toContain("ALL-OR-NOTHING");                            // CLAIM_GUIDANCE header rule
    expect(p).toContain("no hint that you checked anyone");           // hidden mode = zero leakage
    expect(p).toContain("who you investigated, and what you found");  // full-claim beats when going public
  });

  it("a Detective that has CAUGHT a Mafia still reveals (caught outranks vouch), now de-scripted", () => {
    const ctx: TurnContext = {
      ...base, roster, role: "DETECTIVE",
      investigations: [
        { round: 1, target: 1, faction: "TOWN" },   // Boris cleared
        { round: 2, target: 3, faction: "MAFIA" },   // Dmitri caught
      ],
    };
    const p = buildDiscussionPrompt(ctx);
    expect(p).toContain("reveal it now");             // the reveal is still the task…
    expect(p).toContain("say you are the Detective");  // …the three beats stated as requirements…
    expect(p).toContain("investigated Dmitri");        // …phrased in the seat's own words
    expect(p).not.toContain('"I am the Detective. I investigated'); // the verbatim exemplar is gone
    expect(p).toContain("Dmitri"); // the caught Mafia is named as the reveal target
  });

  it("no longer FORCES a Mafia bluff — it carries the open fake-claim PERMISSION instead", () => {
    // The forced fake-Detective branch (with a computed named frame) is gone; a Mafia now gets the open
    // reactor plus CLAIM_GUIDANCE's licence to bluff, and authors the frame itself (diversity-probe).
    const ctx: TurnContext = {
      ...base, roster, role: "MAFIA", teammates: [4],
      persona: { seat: 2, name: "Cleo", blurb: "a peacemaker" },
      transcript: [[0, "Dmitri keeps dodging every question — I suspect him."]],
      decisionStub: { nonce: "deadbeef", phase: "day", round: 2, player: 2, action: "vote" },
    };
    const p = buildDiscussionPrompt(ctx);
    expect(p.toLowerCase()).toContain("falsely claim");    // CLAIM_GUIDANCE permission present
    expect(p).not.toContain("claim the Detective role");   // but no forced bluff TASK
  });

  it("never scripts a frame onto a teammate (there is no computed frame target now)", () => {
    const ctx: TurnContext = {
      ...base, roster, role: "MAFIA", teammates: [4],
      persona: { seat: 2, name: "Cleo", blurb: "a peacemaker" },
      transcript: [
        [0, "Honestly Esme is the one I distrust most, she should be gone today."], // the ally is suspected
        [1, "Right, I'm leaning hard against Esme this round."],
      ],
      decisionStub: { nonce: "deadbeef", phase: "day", round: 2, player: 2, action: "vote" },
    };
    const p = buildDiscussionPrompt(ctx);
    expect(p).not.toContain("Esme is Mafia");              // the ally is never framed in the task
    expect(p).toContain("never knowingly accuse them");    // publicFactsBlock still protects the ally
  });
});

describe("buildDiscussionPrompt — light opening-stance nudge (post-fluidity rework)", () => {
  const sixRoster = [
    { seat: 0, name: "Ada", blurb: "a tactician" },
    { seat: 1, name: "Boris", blurb: "an accuser" },
    { seat: 2, name: "Cleo", blurb: "a peacemaker" },
    { seat: 3, name: "Dmitri", blurb: "a contrarian" },
    { seat: 4, name: "Esme", blurb: "a strategist" },
    { seat: 5, name: "Felix", blurb: "a prosecutor" },
  ];
  const sixBase = (seat: number, round = 2): TurnContext => ({
    persona: { seat, ...sixRoster[seat]! },
    role: "TOWN",
    roster: sixRoster,
    alive: [0, 1, 2, 3, 4, 5],
    transcript: [
      [0, "I think Dmitri is suspicious and hiding something."],
      [1, "Agreed, Dmitri keeps dodging — I'd vote Dmitri."],
      [5, "Dmitri is the one I distrust most today."],
    ],
    decisionStub: { nonce: "deadbeef", phase: "day", round, player: seat, action: "vote" },
    legalTargets: [0, 1, 2, 3, 4, 5].filter((s) => s !== seat),
    stage: "discussion",
  });

  // The suggested opening stance embedded in the open task ("For variety, try <stance> — then say…").
  const stanceOf = (ctx: TurnContext): string | undefined =>
    buildDiscussionPrompt(ctx).match(/For variety, try (.+?) — then say your piece now\./)?.[1];

  it("gives every seat the SAME open reactor task (no forced per-seat rhetorical move)", () => {
    const p = buildDiscussionPrompt(sixBase(2));
    expect(p).toContain("react to the discussion and drive today's vote forward");
    expect(p).toContain("Take a real position");
  });

  it("varies only a LIGHT opening-stance nudge across seats (breaks the shared opening attractor)", () => {
    // Different (seat + round) → a different suggested stance, so seats don't all open the same way.
    const s0 = stanceOf(sixBase(0, 2));
    const s1 = stanceOf(sixBase(1, 2)); // (1+2) vs (0+2) → a different stance
    expect(s0).toBeDefined();
    expect(s1).toBeDefined();
    expect(s0).not.toBe(s1);
  });

  it("rotates a given seat's stance across rounds (not the same lean every day)", () => {
    expect(stanceOf(sixBase(2, 2))).not.toBe(stanceOf(sixBase(2, 3)));
  });

  it("the nudge is TARGET-FREE — it names no player (the model grounds who in the transcript)", () => {
    for (const seat of [0, 1, 2, 3, 4, 5]) {
      const stance = stanceOf(sixBase(seat)) ?? "";
      for (const name of ["Ada", "Boris", "Cleo", "Dmitri", "Esme", "Felix"]) {
        expect(stance).not.toContain(name);
      }
    }
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
    expect(speech).toContain("build your case to the table for voting Boris out today"); // named target
    expect(speech).toContain("go after Boris now"); // and named again in the closing command
    expect(speech).not.toContain("voting seat 1");      // the ask never refers to the target by seat number

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
    expect(lc).toContain("just waiting, never a suspect for that alone");
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

describe("buildVoteSpeechPrompt (merged reason+speech)", () => {
  const roster = [
    { seat: 0, name: "Ada", blurb: "a calm tactician" },
    { seat: 1, name: "Boris", blurb: "a loud accuser" },
    { seat: 2, name: "Cleo", blurb: "a peacemaker" },
    { seat: 3, name: "Dmitri", blurb: "a contrarian" },
    { seat: 4, name: "Esme", blurb: "a quiet strategist" },
  ];
  const ctx: TurnContext = { ...base, roster, transcript: [[0, "Boris is dodging — I suspect him."]] };

  it("asks for ONE call that both picks the target and writes the case (TARGET/CASE format)", () => {
    const p = buildVoteSpeechPrompt(ctx);
    expect(p).toContain("TARGET:");
    expect(p).toContain("CASE:");
    expect(p).toContain("Legal targets");            // the legal-target list (for the pick)
    expect(p).toContain("Boris is dodging");          // grounded in the transcript
    expect(p.toLowerCase()).toContain("in the voice of"); // carries the speech voice directive
  });

  it("carries the role's claim guidance so power roles can still reveal/bluff in the merged call", () => {
    const det = buildVoteSpeechPrompt({ ...ctx, role: "DETECTIVE", investigations: [{ round: 1, target: 1, faction: "MAFIA" }] });
    expect(det).toContain("CLAIM Detective");        // CLAIM_GUIDANCE present
    expect(det).toContain("investigation results");  // its certain facts are available to cite
  });
});

describe("drama directive & speech budget", () => {
  it("injects the DRAMA directive into every PUBLIC-speech prompt", () => {
    for (const p of [
      buildSpeechPrompt(base, 3, "x"),
      buildVoteSpeechPrompt(base),
      buildDiscussionPrompt({ ...base, stage: "discussion" }),
    ]) {
      expect(p).toContain("PLAY TO WIN, AND PLAY TO BE WATCHED"); // the shared drama framing
      expect(p).toContain("take a side, name names");
    }
  });

  it("pairs DRAMA with the plain-English register directive in every PUBLIC-speech prompt", () => {
    for (const p of [
      buildSpeechPrompt(base, 3, "x"),
      buildVoteSpeechPrompt(base),
      buildDiscussionPrompt({ ...base, stage: "discussion" }),
    ]) {
      expect(p).toContain("TALK LIKE A REAL PERSON"); // the shared register framing
      expect(p.toLowerCase()).toContain("plain, everyday english");
    }
  });

  it("injects the GAME-not-real-life frame into every PUBLIC-speech prompt (kills the grief register)", () => {
    for (const p of [
      buildSpeechPrompt(base, 3, "x"),
      buildVoteSpeechPrompt(base),
      buildDiscussionPrompt({ ...base, stage: "discussion" }),
    ]) {
      expect(p).toContain("THIS IS A GAME, NOT REAL LIFE");
      expect(p).toContain("no grief, no mourning");
    }
  });

  it("no longer tells the MAFIA to MOURN its victims (grief-register regression guard)", () => {
    const p = buildReasonPrompt(mafiaCtx).toLowerCase();
    expect(p).toContain("lie");        // the deception licence survives
    expect(p).not.toContain("mourn");  // but the mourn-your-victims grief cue is gone
  });

  it("frames the DRAMA stakes as getting voted out / surviving the night, not living vs dying", () => {
    const p = buildSpeechPrompt(base, 3, "x");
    expect(p).toContain("who gets voted out, who survives the night");
    expect(p).not.toContain("who lives, who dies");
  });

  it("keeps DRAMA out of the PRIVATE night reason (audit text, not performance)", () => {
    const night: TurnContext = {
      ...base, role: "MAFIA", teammates: [4],
      decisionStub: { nonce: "deadbeef", phase: "night", round: 2, player: 2, action: "kill" },
    };
    expect(buildReasonPrompt(night)).not.toContain("PLAY TO WIN, AND PLAY TO BE WATCHED");
  });

  it("marries the drama to grounding — never manufacture facts you could not know", () => {
    const p = buildDiscussionPrompt({ ...base, stage: "discussion" }).toLowerCase();
    expect(p).toContain("never make up facts you could not know");
    expect(p).toContain("never read body language, tone, or nerves"); // NO_INVENTION still enforced
  });

  it("threads the (raised, env-tunable) speech-word budget into the public tasks", () => {
    expect(SPEECH_MAX_WORDS).toBeGreaterThan(40); // bumped from the weak-model 40-word cap
    const spec = `under ${SPEECH_MAX_WORDS} words`;
    expect(buildSpeechPrompt(base, 3, "x")).toContain(spec);
    expect(buildVoteSpeechPrompt(base)).toContain(spec);
    expect(buildDiscussionPrompt({ ...base, stage: "discussion" })).toContain(spec);
  });

  it("still forbids a TOWN public speech from any deception framing after the rework", () => {
    for (const p of [
      buildSpeechPrompt(base, 3, "x").toLowerCase(),   // base is TOWN
      buildVoteSpeechPrompt(base).toLowerCase(),
      buildDiscussionPrompt({ ...base, stage: "discussion" }).toLowerCase(),
    ]) {
      expect(p).not.toContain("lie");
      expect(p).not.toContain("cover");
    }
  });
});

describe("transcript window (TRANSCRIPT_MAX_ENTRIES)", () => {
  // A long transcript: more entries than the cap, each line uniquely identifiable.
  const long = Array.from({ length: TRANSCRIPT_MAX_ENTRIES + 6 }, (_, i) => [i % 5, `line number ${i} marker`] as const);
  const longCtx: TurnContext = { ...base, transcript: long };

  it("recentTranscript keeps only the last TRANSCRIPT_MAX_ENTRIES and reports the elided count", () => {
    const { shown, elided } = recentTranscript(longCtx);
    expect(shown.length).toBe(TRANSCRIPT_MAX_ENTRIES);
    expect(elided).toBe(6);
    expect(shown[shown.length - 1]![1]).toBe(long[long.length - 1]![1]); // newest kept
  });

  it("shows the most recent lines, drops the oldest, and flags that earlier lines were omitted", () => {
    const p = buildReasonPrompt(longCtx);
    expect(p).toContain(`line number ${long.length - 1} marker`); // newest is shown
    expect(p).not.toContain("line number 0 marker");              // oldest is dropped
    expect(p).toContain("earlier rounds omitted");                 // elision marker present
  });

  it("does not window or annotate a transcript within the cap", () => {
    const shortCtx: TurnContext = { ...base, transcript: [[0, "only line here marker"]] };
    const p = buildReasonPrompt(shortCtx);
    expect(p).toContain("only line here marker");
    expect(p).not.toContain("omitted");
    expect(recentTranscript(shortCtx).elided).toBe(0);
  });
});
