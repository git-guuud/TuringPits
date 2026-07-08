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
    // Legal targets are present but listed in a per-turn shuffled DISPLAY order (breaks seat-0 bias),
    // so assert the SET, not a fixed sequence.
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

  it("flips to a first-person self-defense when the table is turning on this seat", () => {
    const ctx: TurnContext = {
      ...base, roster,
      persona: { seat: 2, name: "Cleo", blurb: "a peacemaker" },
      transcript: [[0, "I suspect Cleo is hiding something — let's vote her out today."]],
    };
    const p = buildDiscussionPrompt(ctx);
    expect(p).toContain("The table is turning on YOU");
    expect(p).toContain("Fight back now");
    expect(p).not.toContain("move today's vote forward"); // not the generic reactor task
  });

  it("does NOT flip to self-defense on a purely positive mention of this seat", () => {
    const ctx: TurnContext = {
      ...base, roster,
      persona: { seat: 2, name: "Cleo", blurb: "a peacemaker" },
      transcript: [[0, "I really trust Cleo — she's been thoughtful and fair today."]],
    };
    const p = buildDiscussionPrompt(ctx);
    expect(p).not.toContain("The table is turning on YOU");
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

  it("a Detective that has CAUGHT a Mafia still reveals (caught outranks vouch)", () => {
    const ctx: TurnContext = {
      ...base, roster, role: "DETECTIVE",
      investigations: [
        { round: 1, target: 1, faction: "TOWN" },   // Boris cleared
        { round: 2, target: 3, faction: "MAFIA" },   // Dmitri caught
      ],
    };
    const p = buildDiscussionPrompt(ctx);
    expect(p).toContain("reveal it now");          // the reveal task (with a fill-in template)
    expect(p).toContain("I am the Detective");      // the template exemplar
    expect(p).toContain("Dmitri"); // the caught Mafia is named as the reveal target
  });

  it("hands a round-2 MAFIA a fake-Detective bluff aimed at the most-suspected non-teammate", () => {
    const ctx: TurnContext = {
      ...base, roster, role: "MAFIA", teammates: [4], // Esme (seat 4) is the secret ally
      persona: { seat: 2, name: "Cleo", blurb: "a peacemaker" },
      transcript: [
        [0, "Dmitri keeps dodging every question — I suspect him."],
        [1, "I'd vote Dmitri today, he's hiding something."],
      ],
      decisionStub: { nonce: "deadbeef", phase: "day", round: 2, player: 2, action: "vote" },
    };
    const p = buildDiscussionPrompt(ctx);
    expect(p).toContain("claim the Detective role");             // the bluff is the TASK
    expect(p).toContain("Dmitri is Mafia");                      // aimed at the suspected non-teammate
    expect(p).toContain("vote Dmitri out today");
    expect(p).not.toContain("vote Esme out");                    // never frames the teammate
    expect(p).not.toContain("Esme is Mafia");
    expect(p).not.toContain("tonight");                          // safe for the day guard
  });

  it("never frames a teammate even when the table most suspects the ally", () => {
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
    expect(p).toContain("claim the Detective role"); // still bluffs (a non-teammate exists)
    expect(p).not.toContain("vote Esme out today");  // but the frame is never the ally
    expect(p).not.toContain("Esme is Mafia");
  });

  it("does NOT bluff a round-1 MAFIA (no credible frame has formed yet)", () => {
    const ctx: TurnContext = {
      ...base, roster, role: "MAFIA", teammates: [4],
      persona: { seat: 2, name: "Cleo", blurb: "a peacemaker" },
      transcript: [[0, "Dmitri keeps dodging — I suspect him."]],
      decisionStub: { nonce: "deadbeef", phase: "day", round: 1, player: 2, action: "vote" },
    };
    const p = buildDiscussionPrompt(ctx);
    expect(p).not.toContain("claim the Detective role");
    expect(p).toContain("do exactly this:"); // the generic per-seat angle reactor instead
  });

  it("a round-2 MAFIA under fire turns the bluff on its accuser (bluff outranks generic self-defense)", () => {
    // A Mafia is usually suspected by round 2; claiming Detective and framing the accuser is a stronger,
    // more watchable reply than a bland rebuttal — so the bluff outranks the self-defense branch here.
    const ctx: TurnContext = {
      ...base, roster, role: "MAFIA", teammates: [4],
      persona: { seat: 2, name: "Cleo", blurb: "a peacemaker" },
      transcript: [[0, "Cleo is hiding something — let's vote Cleo out today."]], // Ada accuses Cleo
      decisionStub: { nonce: "deadbeef", phase: "day", round: 2, player: 2, action: "vote" },
    };
    const p = buildDiscussionPrompt(ctx);
    expect(p).toContain("claim the Detective role");
    expect(p).toContain("Ada is Mafia");                        // frames the accuser, not a random seat
    expect(p).not.toContain("The table is turning on YOU");     // not the generic self-defense
  });

  it("a round-1 MAFIA under fire still falls back to self-defense (no bluff before round 2)", () => {
    const ctx: TurnContext = {
      ...base, roster, role: "MAFIA", teammates: [4],
      persona: { seat: 2, name: "Cleo", blurb: "a peacemaker" },
      transcript: [[0, "Cleo is hiding something — let's vote Cleo out today."]],
      decisionStub: { nonce: "deadbeef", phase: "day", round: 1, player: 2, action: "vote" },
    };
    const p = buildDiscussionPrompt(ctx);
    expect(p).not.toContain("claim the Detective role");
    expect(p).toContain("The table is turning on YOU");
  });
});

describe("buildDiscussionPrompt — per-seat rhetorical angles (mode-collapse fix)", () => {
  // A 6-seat table so the (seat + round) angle assignment can cover all six angles in one round.
  const sixRoster = [
    { seat: 0, name: "Ada", blurb: "a tactician" },
    { seat: 1, name: "Boris", blurb: "an accuser" },
    { seat: 2, name: "Cleo", blurb: "a peacemaker" },
    { seat: 3, name: "Dmitri", blurb: "a contrarian" },
    { seat: 4, name: "Esme", blurb: "a strategist" },
    { seat: 5, name: "Felix", blurb: "a prosecutor" },
  ];
  // Several seats have spoken (and the table is leaning on Dmitri) so the name-bearing angles fire.
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

  // The last line of the prompt IS the assigned angle task (it ends on its action command).
  const taskOf = (ctx: TurnContext): string => {
    const lines = buildDiscussionPrompt(ctx).split("\n");
    return lines[lines.length - 1]!;
  };

  it("gives every living seat a DISTINCT angle in the same round (no shared template)", () => {
    const tasks = [0, 1, 2, 3, 4, 5].map((seat) => taskOf(sixBase(seat)));
    expect(new Set(tasks).size).toBe(tasks.length); // all six are different
  });

  it("rotates a given seat's angle across rounds (so it isn't the same move every day)", () => {
    const r2 = taskOf(sixBase(2, 2));
    const r3 = taskOf(sixBase(2, 3));
    expect(r2).not.toBe(r3);
  });

  it("each angle ends on its own action command, not on a 'today not tonight' reminder", () => {
    for (const seat of [0, 1, 2, 3, 4, 5]) {
      const t = taskOf(sixBase(seat));
      expect(t.trimEnd()).toMatch(/now\.$|now\.”?$/i); // … now.
      expect(t.trimEnd()).not.toMatch(/tonight"?\)?\.?$/i);
    }
  });

  it("angles only name players grounded in the transcript, never a silent uninvolved seat", () => {
    // Grounded = a seat that has spoken (0=Ada, 1=Boris, 5=Felix) or the seat the table is already
    // suspecting (3=Dmitri, the heat target). Cleo (2) and Esme (4) are neither, so no angle may
    // put words on them — that would be the exact invented-behaviour fabrication the guard rejects.
    const grounded = new Set(["Ada", "Boris", "Felix", "Dmitri"]);
    for (const seat of [0, 1, 2, 3, 4, 5]) {
      const t = taskOf(sixBase(seat));
      for (const name of ["Cleo", "Esme"]) {
        if (name === sixRoster[seat]!.name) continue; // ignore self-name (the angles never use it)
        expect(t).not.toContain(name);
      }
      const named = ["Ada", "Boris", "Dmitri", "Esme", "Felix"].filter(
        (n) => n !== sixRoster[seat]!.name && t.includes(n),
      );
      for (const n of named) expect(grounded.has(n)).toBe(true);
    }
  });

  it("the defender angle targets whoever the table is piling on (the most-suspected seat)", () => {
    // Find the seat whose (seat+round)%6 === 2 (the defender angle): seat 0 at round 2.
    const t = taskOf(sixBase(0, 2));
    expect(t).toContain("Dmitri is being mobbed"); // the pile-on target, chosen concretely
  });

  it("falls back to a name-free angle variant when no peer has spoken yet", () => {
    // Round 1, second speaker, only the opener (seat 0) has spoken: a questioner/builder seat still
    // gets a coherent angle, just without a peer name.
    const ctx: TurnContext = {
      persona: { seat: 4, ...sixRoster[4]! }, // (4 + 2) % 6 = 0 → questioner
      role: "TOWN",
      roster: sixRoster,
      alive: [0, 1, 2, 3, 4, 5],
      transcript: [[0, "I have no read yet — let's hear from everyone."]],
      decisionStub: { nonce: "deadbeef", phase: "day", round: 2, player: 4, action: "vote" },
      legalTargets: [0, 1, 2, 3, 5],
      stage: "discussion",
    };
    const t = taskOf(ctx);
    // peer = Ada (seat 0 spoke); questioner angle names Ada. Now use a transcript where the only
    // speaker is the seat itself so spokenPeers is empty → name-free variant.
    expect(t).toContain("Ada"); // sanity: peer-bearing when a peer exists
    const noPeer: TurnContext = { ...ctx, transcript: [[4, "I'll open: who do we trust?"]] };
    const tNoPeer = taskOf(noPeer);
    expect(tNoPeer.toLowerCase()).toContain("ask it now"); // questioner fallback, no peer name
    for (const name of ["Ada", "Boris", "Cleo", "Dmitri", "Felix"]) expect(tNoPeer).not.toContain(name);
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
      expect(p).toContain("THIS IS LIVE THEATRE"); // the shared drama framing
      expect(p.toLowerCase()).toContain("play to be watched");
    }
  });

  it("keeps DRAMA out of the PRIVATE night reason (audit text, not performance)", () => {
    const night: TurnContext = {
      ...base, role: "MAFIA", teammates: [4],
      decisionStub: { nonce: "deadbeef", phase: "night", round: 2, player: 2, action: "kill" },
    };
    expect(buildReasonPrompt(night)).not.toContain("THIS IS LIVE THEATRE");
  });

  it("marries the drama to grounding — never manufacture facts you could not know", () => {
    const p = buildDiscussionPrompt({ ...base, stage: "discussion" }).toLowerCase();
    expect(p).toContain("never manufacture facts you could not know");
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
