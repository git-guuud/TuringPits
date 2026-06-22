import { describe, it, expect } from "vitest";
import { hasBadMarker, hasNonEnglish, cleanDaySpeech, cleanNightReason, stripSpeakerLabels, isEcho, namifySeats, forbiddenNames, stripLeadingEcho, refersToSelfInThirdPerson, accusesClearedTown, stripMarkedSentences, sentenceHasBadMarker } from "./sanitize.js";

const ROSTER = [
  { seat: 0, name: "Ada" }, { seat: 1, name: "Boris" }, { seat: 2, name: "Cleo" },
  { seat: 3, name: "Dmitri" }, { seat: 4, name: "Esme" },
];

const NAMES = ["Ada", "Boris", "Cleo", "Dmitri", "Esme"];
import type { Attestation, InferenceProvider } from "./types.js";

const att = {} as Attestation;
/** A provider whose `complete` returns scripted texts in order; records the prompts it saw. */
function scripted(texts: string[]): { provider: InferenceProvider; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    provider: {
      async complete(prompt: string) {
        prompts.push(prompt);
        return { text: texts[i++] ?? "", attestation: att };
      },
    },
  };
}

describe("hasBadMarker", () => {
  it("flags night-confusion, the silence trope, and not-spoken-yet accusations", () => {
    for (const s of [
      "I think seat 3 is the mafia tonight.",
      "Their silence is suspicious.",
      "Seat 4 has been silent the whole game.",
      "Seat 4 hasn't spoken much, which worries me.",
      "Seat 2 has not spoken, so they're hiding something.",
      "Esme has been secretive since the night began.",
      "He was acting strange during the night.",
      "Their lack of involvement raises concerns.",
      "Seat 1's defensive stance is telling.",
    ]) {
      expect(hasBadMarker(s)).toBe(true);
    }
  });

  it("flags invented physical tells (impossible in a text game)", () => {
    for (const s of [
      "Boris keeps avoiding eye contact, he's clearly hiding something.",
      "Her body language is all wrong today.",
      "Cleo is fidgeting and her nervous tic gives her away.",
      "His facial expression when I accused him said it all.",
    ]) {
      expect(hasBadMarker(s)).toBe(true);
    }
  });

  it("flags invented demeanour / behavioural-baseline fabrication (impossible in a text game)", () => {
    for (const s of [
      "Her recent behavior doesn't align with her usual demeanor, so I'm wary.", // the exact 17:01 leak
      "Esme has been acting unusually secretive lately.",
      "Boris is acting strangely today, it worries me.",
      "Cleo's whole demeanour is off.",
      "Dmitri just isn't his usual self.",
      "That's so out of character for Felix.",
      "Ada hasn't been herself this round.",
      "He's acting cagey and defensive about the vote.",
    ]) {
      expect(hasBadMarker(s)).toBe(true);
    }
  });

  it("does NOT over-block grounded reads that merely share a stem ('usually', 'behavior', bare 'secretive')", () => {
    for (const s of [
      "I usually agree with Boris, but his argument today is thin.",
      "Esme's voting behavior is what makes me cautious about her.",
      "Boris has been secretive about which way he'll vote.",
      "I'm acting on what Dmitri actually said, not a hunch.",
    ]) {
      expect(hasBadMarker(s)).toBe(false);
    }
  });

  it("flags fabricated emotional state attributed to ANOTHER player (nervous around X, etc.)", () => {
    for (const s of [
      "Why does Felix always seem so nervous around me?",          // the cascading 18:01 leak
      "His nervousness around Boris is what worries me.",
      "Dmitri is nervous and won't meet the moment.",
      "Esme looks anxious whenever the vote comes up.",
      "Boris seems uneasy about where this is going.",
    ]) {
      expect(hasBadMarker(s)).toBe(true);
    }
  });

  it("does NOT block the SPEAKER's own stated feeling ('I'm nervous', 'makes me nervous')", () => {
    for (const s of [
      "I'm nervous about rushing this vote without a real case.",
      "Honestly, voting blind makes me nervous, so let's slow down.",
    ]) {
      expect(hasBadMarker(s)).toBe(false);
    }
  });

  it("passes clean, grounded speech (incl. affirmative 'has spoken')", () => {
    for (const s of [
      "I'm voting for seat 3 today; my read is thin so it's provisional.",
      "Seat 1 said they want to watch the vote, which makes me cautious about them.",
      "Now that everyone has spoken, I lean toward seat 2 based on their own words.",
      "I have no firm read yet and want to hear more before today's vote.",
      "Boris was killed by the Mafia during the previous night, so we are down a player.",
    ]) {
      expect(hasBadMarker(s)).toBe(false);
    }
  });
});

describe("cleanDaySpeech", () => {
  it("returns clean speech untouched without a second call", async () => {
    const { provider, prompts } = scripted(["should-not-be-used"]);
    const out = await cleanDaySpeech(provider, "PROMPT", "I lean toward seat 2 based on their own words today.", "FB");
    expect(out).toBe("I lean toward seat 2 based on their own words today.");
    expect(prompts.length).toBe(0); // no regeneration needed
  });

  it("regenerates once with a correction when the first draft is dirty, and uses the clean retry", async () => {
    const { provider, prompts } = scripted(["I'm voting today on a thin read."]);
    const out = await cleanDaySpeech(provider, "PROMPT", "Their silence is suspicious tonight.", "FB");
    expect(out).toBe("I'm voting today on a thin read.");
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("REJECTED"); // correction note appended
  });

  it("falls back to the safe line when the regenerated speech is still dirty", async () => {
    const { provider } = scripted(["Still about their silence."]);
    const out = await cleanDaySpeech(provider, "PROMPT", "Their silence tonight is telling.", "SAFE-FALLBACK");
    expect(out).toBe("SAFE-FALLBACK");
  });

  it("falls back to the safe line when the regeneration call throws", async () => {
    const provider: InferenceProvider = {
      async complete() { throw new Error("429 rate limit"); },
    };
    const out = await cleanDaySpeech(provider, "PROMPT", "silence tonight", "SAFE-FALLBACK");
    expect(out).toBe("SAFE-FALLBACK");
  });
});

describe("forbiddenNames", () => {
  it("flags a roster name that is not in the allow-list", () => {
    expect(forbiddenNames("I think Esme is avoiding the question.", NAMES, ["Cleo", "Boris"])).toEqual(["Esme"]);
  });

  it("allows names on the allow-list and ignores names absent from the text", () => {
    expect(forbiddenNames("Boris made a fair point, so I trust Cleo less.", NAMES, ["Boris", "Cleo"])).toEqual([]);
  });

  it("returns nothing when the roster is empty (back-compat)", () => {
    expect(forbiddenNames("Esme is hiding something.", [], [])).toEqual([]);
  });
});

describe("hasNonEnglish", () => {
  it("flags CJK code-switching and passes clean English with curly punctuation", () => {
    expect(hasNonEnglish("Let's weigh 昨晚的投票结果 carefully.")).toBe(true);
    expect(hasNonEnglish("I'd rather wait — Boris's point isn't proven yet.")).toBe(false);
  });
});

describe("cleanDaySpeech — language guard", () => {
  it("regenerates a CJK-contaminated draft with a language correction, then uses the clean retry", async () => {
    const { provider, prompts } = scripted(["I have no firm read yet and want to hear more today."]);
    const out = await cleanDaySpeech(provider, "PROMPT", "Cleo 强调昨晚的投票结果, suspicious.", "FB", NAMES);
    expect(out).toBe("I have no firm read yet and want to hear more today.");
    expect(prompts[0]).toMatch(/English/);
  });

  it("falls back when the retry is still non-English", async () => {
    const { provider } = scripted(["还是中文"]);
    const out = await cleanDaySpeech(provider, "PROMPT", "全部中文", "SAFE-FALLBACK", NAMES);
    expect(out).toBe("SAFE-FALLBACK");
  });
});

describe("cleanDaySpeech — fabrication guard", () => {
  it("rejects a draft that names a player who has not spoken, then uses the clean retry", async () => {
    const { provider, prompts } = scripted(["I have no firm read yet and want to hear more today."]);
    const out = await cleanDaySpeech(
      provider, "PROMPT", "Esme is dodging the question, I suspect her.", "FB",
      NAMES, [], undefined, ["Boris"], // only Boris (and implicitly nobody else) has spoken
    );
    expect(out).toBe("I have no firm read yet and want to hear more today.");
    expect(prompts[0]).toContain("Esme");
    expect(prompts[0]).toContain("not spoken");
  });

  it("falls back when the retry still invents a silent player", async () => {
    const { provider } = scripted(["Still suspicious of Esme."]);
    const out = await cleanDaySpeech(
      provider, "PROMPT", "Esme is dodging the question.", "SAFE-FALLBACK",
      NAMES, [], undefined, ["Boris"],
    );
    expect(out).toBe("SAFE-FALLBACK");
  });

  it("permits a named spoken player (no false positive)", async () => {
    const { provider, prompts } = scripted(["unused"]);
    const out = await cleanDaySpeech(
      provider, "PROMPT", "Boris said he'll watch the vote, which makes me cautious about him.", "FB",
      NAMES, [], undefined, ["Boris"],
    );
    expect(out).toBe("Boris said he'll watch the vote, which makes me cautious about him.");
    expect(prompts.length).toBe(0);
  });
});

describe("isEcho", () => {
  const prior = ["Cleo mentioned focusing on today's vote, suggesting she might be hiding her own role."];

  it("flags a verbatim or near-verbatim repeat of a prior line", () => {
    expect(isEcho(prior[0], prior)).toBe(true);
    expect(isEcho("Cleo mentioned focusing on today's vote, which suggests she might be hiding her role.", prior)).toBe(true);
  });

  it("passes a genuinely different point", () => {
    expect(isEcho("I trust Boris — he was the only one to commit to a concrete read.", prior)).toBe(false);
  });

  it("never flags very short lines", () => {
    expect(isEcho("I vote Ada.", prior)).toBe(false);
  });

  it("catches an echo embedded in a longer reply (diluted whole-text overlap)", () => {
    // The first sentence verbatim-copies the prior line; the rest is new padding.
    const embedded =
      "Cleo mentioned focusing on today's vote, suggesting she might be hiding her own role. " +
      "Separately, I want us all to stay calm and weigh the evidence carefully before deciding anything.";
    expect(isEcho(embedded, prior)).toBe(true);
  });
});

describe("stripSpeakerLabels — trailing dangling header", () => {
  it("drops a trailing 'Today's vote:' fragment on its own line", () => {
    const t = "Ada mentioned she has no information yet, but her words suggest she is cautious.\n\nToday's vote:";
    expect(stripSpeakerLabels(t, NAMES)).toBe("Ada mentioned she has no information yet, but her words suggest she is cautious.");
  });

  it("leaves an inline colon (e.g. a quote lead-in) untouched", () => {
    const t = "Boris said it plainly: he wants to wait before voting.";
    expect(stripSpeakerLabels(t, NAMES)).toBe(t);
  });
});

describe("namifySeats", () => {
  it("replaces 'seat N' references with the roster name", () => {
    expect(namifySeats("I suspect seat 0 due to her position at seat 0.", ROSTER))
      .toBe("I suspect Ada due to her position at Ada.");
    expect(namifySeats("Investigating seat 3 and seat 4.", ROSTER)).toBe("Investigating Dmitri and Esme.");
  });

  it("leaves text without seat references untouched", () => {
    expect(namifySeats("Voting for Boris today.", ROSTER)).toBe("Voting for Boris today.");
  });
});

describe("cleanDaySpeech — echo guard", () => {
  it("rejects a parroted speech and falls back when the retry still echoes", async () => {
    const prior = ["Ada mentioned focusing on today's vote, suggesting she is hiding her own role."];
    const echo = "Ada mentioned focusing on today's vote, suggesting she is hiding her own role.";
    const provider: InferenceProvider = { async complete() { return { text: echo, attestation: att }; } };
    const out = await cleanDaySpeech(provider, "PROMPT", echo, "DISTINCT-FALLBACK", [], prior);
    expect(out).toBe("DISTINCT-FALLBACK");
  });

  it("accepts a distinct speech without regenerating", async () => {
    const prior = ["Ada mentioned focusing on today's vote."];
    const distinct = "I'd rather watch how Boris votes before I trust his read at all.";
    const { provider, prompts } = scripted(["unused"]);
    const out = await cleanDaySpeech(provider, "PROMPT", distinct, "FB", [], prior);
    expect(out).toBe(distinct);
    expect(prompts.length).toBe(0);
  });
});

describe("stripLeadingEcho", () => {
  const prior = ["Today, I need to hear from everyone who has spoken already. Who is hiding a dark secret?"];

  it("drops a leading verbatim copy of a prior line and keeps the genuine point after it", () => {
    const t = "Today, I need to hear from everyone who has spoken already. Who is hiding a dark secret? Honestly, Boris is pushing too hard and I don't buy it.";
    expect(stripLeadingEcho(t, prior)).toBe("Honestly, Boris is pushing too hard and I don't buy it.");
  });

  it("leaves a genuinely original opening untouched", () => {
    const t = "Boris is pushing too hard for my taste, and I want to know exactly why.";
    expect(stripLeadingEcho(t, prior)).toBe(t);
  });

  it("returns the original text when the whole reply is an echo (lets the echo guard reject it)", () => {
    expect(stripLeadingEcho(prior[0]!, prior)).toBe(prior[0]);
  });

  it("is a no-op with no prior lines", () => {
    expect(stripLeadingEcho("Anything at all here.", [])).toBe("Anything at all here.");
  });
});

describe("refersToSelfInThirdPerson", () => {
  it("flags the speaker narrating itself in the third person", () => {
    expect(refersToSelfInThirdPerson("Look at how Felix is handling himself, so confident.", "Felix")).toBe(true);
    expect(refersToSelfInThirdPerson("Cassius has been consistently vocal here.", "Cassius")).toBe(true);
    expect(refersToSelfInThirdPerson("Cassius' lack of substance is telling.", "Cassius")).toBe(true);
  });

  it("flags the speaker addressing ITSELF by name in the second person (vocative)", () => {
    // Real leaks: a seat names itself and tells itself to speak — confused self-address.
    expect(refersToSelfInThirdPerson("Oracle, please share your thoughts with the table today.", "Oracle")).toBe(true);
    expect(refersToSelfInThirdPerson("Let's focus on the evidence. Oracle, share your thoughts.", "Oracle")).toBe(true);
    expect(refersToSelfInThirdPerson("Oracle, why haven't you spoken up yet?", "Oracle")).toBe(true);
  });

  it("allows first person and a bare self-introduction", () => {
    expect(refersToSelfInThirdPerson("I'm Felix, and I think Boris is bluffing.", "Felix")).toBe(false);
    expect(refersToSelfInThirdPerson("I won't let Boris off the hook today.", "Felix")).toBe(false);
    // Addressing ANOTHER player by name in the second person is legitimate, not self-reference.
    expect(refersToSelfInThirdPerson("Boris, please share your thoughts with us today.", "Felix")).toBe(false);
  });

  it("does not flag the speaker naming someone else", () => {
    expect(refersToSelfInThirdPerson("Boris is dodging and Cleo agrees with me.", "Felix")).toBe(false);
  });
});

describe("cleanDaySpeech — leading-echo salvage + self-reference", () => {
  it("salvages the real point after a copied preamble instead of rejecting the whole line", async () => {
    const prior = ["Boris asks who among us is hiding a dark secret today."];
    const draft = "Boris asks who among us is hiding a dark secret today. I'll say it plainly: I don't trust Cleo's dodging.";
    const { provider, prompts } = scripted(["unused"]);
    const out = await cleanDaySpeech(provider, "PROMPT", draft, "FB", NAMES, prior, undefined, ["Boris", "Cleo"]);
    expect(out).toBe("I'll say it plainly: I don't trust Cleo's dodging.");
    expect(prompts.length).toBe(0); // salvaged with no regeneration call
  });

  it("regenerates when the speaker narrates itself in the third person, then uses the first-person retry", async () => {
    const { provider, prompts } = scripted(["I think Boris is the one stalling, and I'm voting that way today."]);
    const out = await cleanDaySpeech(
      provider, "PROMPT", "Cleo has been vocal and Cleo's points don't add up.", "FB",
      NAMES, [], undefined, NAMES, "Cleo",
    );
    expect(out).toBe("I think Boris is the one stalling, and I'm voting that way today.");
    expect(prompts[0]).toContain("third person");
  });
});

describe("sentenceHasBadMarker — own-night-claim exemption", () => {
  it("exempts a night reference INSIDE one's own investigation claim (real reveal / Mafia bluff)", () => {
    for (const s of [
      "I investigated Boris last night, and he is the Mafia.",
      "I'm the Detective — my investigation last night proved Dmitri is Mafia.",
      "I checked Esme last night and she came back clean.",
    ]) {
      expect(sentenceHasBadMarker(s)).toBe(false);
    }
  });

  it("still flags a fabricated night observation of someone ELSE (not a claim)", () => {
    for (const s of [
      "Boris was acting suspicious last night.",
      "Dmitri said nothing last night, which worries me.",
    ]) {
      expect(sentenceHasBadMarker(s)).toBe(true);
    }
  });

  it("still flags OTHER fabrication even inside a claim (only the night WORD is exempt)", () => {
    expect(sentenceHasBadMarker("I investigated Boris last night and his demeanor was off.")).toBe(true);
    expect(sentenceHasBadMarker("I'm the Detective and Boris was acting nervous last night.")).toBe(true);
  });
});

describe("stripMarkedSentences", () => {
  it("keeps an investigation-claim sentence that cites the night, dropping only true fabrication", () => {
    const draft =
      "I investigated Boris last night and he is the Mafia. His demeanor has been off all game. Vote Boris out today.";
    expect(stripMarkedSentences(draft)).toBe(
      "I investigated Boris last night and he is the Mafia. Vote Boris out today.",
    );
  });

  it("salvages a power-role claim/bluff by dropping only the fabricated sentence", () => {
    const draft =
      "I am the Detective, and my investigation proved Dmitri is the Mafia. He has been evasive and suspicious tonight. Let us vote Dmitri out today.";
    const out = stripMarkedSentences(draft);
    expect(out).toBe("I am the Detective, and my investigation proved Dmitri is the Mafia. Let us vote Dmitri out today.");
    expect(hasBadMarker(out)).toBe(false);
  });

  it("leaves clean multi-sentence text untouched", () => {
    const clean = "I lean toward Dmitri based on his own words. Let us vote him out today.";
    expect(stripMarkedSentences(clean)).toBe(clean);
  });

  it("does not salvage a single dirty sentence (leaves it for the guard to reject)", () => {
    const one = "Dmitri has been evasive and suspicious tonight.";
    expect(stripMarkedSentences(one)).toBe(one);
  });

  it("keeps the original when salvage would leave too little to be a real contribution", () => {
    const draft = "Hmm. Dmitri seems evasive and suspicious tonight, so vote him out tonight.";
    expect(stripMarkedSentences(draft)).toBe(draft); // only "Hmm." would survive → not enough
  });
});

describe("accusesClearedTown", () => {
  it("flags a Detective pushing the vote onto / casting suspicion on a seat it cleared", () => {
    // The exact live failure: investigated Esme=TOWN, then railroaded her in discussion.
    const live =
      "Today's vote should focus on Esme. She's been acting unusually secretive lately, and her recent behavior doesn't align with her usual demeanor. I believe she might be hiding something. Let's vote her out today.";
    expect(accusesClearedTown(live, ["Esme"])).toEqual(["Esme"]);
    for (const s of [
      "I say we vote Esme out today.",
      "My vote is Esme — she keeps dodging the real questions.",
      "Esme is the one hiding something here.",
      "Esme seems suspicious to me, plain and simple.",
      "Esme should go today, no question.",
      "Honestly, I distrust Esme more than anyone.",
      "Let's all target Esme this round.",
    ]) {
      expect(accusesClearedTown(s, ["Esme"])).toEqual(["Esme"]);
    }
  });

  it("does NOT flag vouching for, defending, or merely mentioning a cleared seat", () => {
    for (const s of [
      "Esme is innocent — look hard at Boris instead, he's the one dodging.", // vouch + redirect
      "I trust Esme completely; my suspicion is on Dmitri today.",
      "Don't let the table vote Esme out — she's clean.",                      // defence (negated)
      "I won't turn on Esme; stand with me and we pressure Boris.",
      "I'm with Esme here, and I think Boris is bluffing.",                    // positive mention
      "Esme made a sharp point earlier that I happen to agree with.",
    ]) {
      expect(accusesClearedTown(s, ["Esme"])).toEqual([]);
    }
  });

  it("only flags the CLEARED name, never another seat the same line accuses", () => {
    // Vouches for cleared Esme while (correctly) accusing un-cleared Boris — only Esme is protected.
    const s = "Esme is innocent, so my vote is Boris today — he's the one hiding something.";
    expect(accusesClearedTown(s, ["Esme"])).toEqual([]);
    // Sentence-scoped: a Boris accusation in its own sentence never spills onto a cleared seat.
    const two = "I have cleared Esme in my own way. Boris is the suspect — vote Boris out.";
    expect(accusesClearedTown(two, ["Esme"])).toEqual([]);
  });

  it("reports each cleared seat the line accuses, and is a no-op with no clears", () => {
    const s = "We should remove Esme, and frankly Cleo is hiding something too.";
    expect(accusesClearedTown(s, ["Esme", "Cleo"]).sort()).toEqual(["Cleo", "Esme"]);
    expect(accusesClearedTown(s, [])).toEqual([]);
  });
});

describe("cleanDaySpeech — cleared-Town guard", () => {
  // clearedNames is the 10th arg; the day-discussion caller passes a Detective's living Town clears.
  it("rejects a Detective accusing its cleared seat, then uses the clean (vouch) retry", async () => {
    const { provider, prompts } = scripted(["Esme has my trust — Boris is the one I want answers from today."]);
    const out = await cleanDaySpeech(
      provider, "PROMPT", "Today's vote should focus on Esme; she's hiding something. Vote her out.", "FB",
      NAMES, [], undefined, NAMES, "Cleo", ["Esme"],
    );
    expect(out).toBe("Esme has my trust — Boris is the one I want answers from today.");
    expect(prompts[0]).toContain("innocent Town"); // the cleared-Town correction was appended
    expect(prompts[0]).toContain("Esme");
  });

  it("falls back to the safe line when the retry still accuses the cleared seat", async () => {
    const { provider } = scripted(["No, Esme really is suspicious, vote her out."]);
    const out = await cleanDaySpeech(
      provider, "PROMPT", "Esme is the mafia, vote Esme out today.", "SAFE-FALLBACK",
      NAMES, [], undefined, NAMES, "Cleo", ["Esme"],
    );
    expect(out).toBe("SAFE-FALLBACK");
  });

  it("passes a genuine vouch for a cleared seat untouched (no false reject)", async () => {
    const { provider, prompts } = scripted(["unused"]);
    const vouch = "Esme is innocent in my book — let's put real pressure on Boris instead today.";
    const out = await cleanDaySpeech(
      provider, "PROMPT", vouch, "FB", NAMES, [], undefined, NAMES, "Cleo", ["Esme"],
    );
    expect(out).toBe(vouch);
    expect(prompts.length).toBe(0); // no regeneration — vouching is exactly what it should do
  });
});

describe("cleanDaySpeech — marked-sentence salvage", () => {
  it("salvages a Mafia bluff wrapped around one fabricated sentence, with no regeneration", async () => {
    const { provider, prompts } = scripted(["unused"]);
    const draft =
      "I am the Detective, and my investigation proved Dmitri is the Mafia. He has been evasive and suspicious tonight. Let us vote Dmitri out today.";
    const out = await cleanDaySpeech(provider, "PROMPT", draft, "FB", NAMES, [], undefined, NAMES, "Cleo");
    expect(out).toBe("I am the Detective, and my investigation proved Dmitri is the Mafia. Let us vote Dmitri out today.");
    expect(prompts.length).toBe(0); // salvaged in-place, the drama survives
  });

  it("keeps a Detective reveal that cites its own night investigation (no false night-reject)", async () => {
    const { provider, prompts } = scripted(["unused"]);
    const reveal = "I investigated Boris last night and he is the Mafia. Vote Boris out today.";
    const out = await cleanDaySpeech(provider, "PROMPT", reveal, "FB", NAMES, [], undefined, NAMES, "Esme");
    expect(out).toBe(reveal); // the explicit role-claim survives intact, night reference and all
    expect(prompts.length).toBe(0);
  });
});

describe("stripSpeakerLabels", () => {
  it("removes a leading 'Name:' prefix from the speaker's own line", () => {
    expect(stripSpeakerLabels("Esme: I agree with Boris.", NAMES)).toBe("I agree with Boris.");
    expect(stripSpeakerLabels("seat 3: my point.", NAMES)).toBe("my point.");
  });

  it("truncates a scripted second speaker, keeping only the first utterance", () => {
    const scripted = "Esme: I've been watching Cleo.\n\nBoris: I agree with Esme about Cleo.";
    expect(stripSpeakerLabels(scripted, NAMES)).toBe("I've been watching Cleo.");
  });

  it("leaves clean single-speaker text untouched", () => {
    const s = "I'm voting for Cleo today; her own words make me cautious.";
    expect(stripSpeakerLabels(s, NAMES)).toBe(s);
  });
});

describe("cleanNightReason", () => {
  it("passes grounded reasoning through unchanged", () => {
    const r = "Cleo claimed the Detective role, so she is the safest kill.";
    expect(cleanNightReason(r, "kill", "Cleo")).toBe(r);
  });

  it("replaces invented round-1 reads with an honest role-appropriate line", () => {
    for (const bad of [
      "Boris seems most confident and has made bold claims.",
      "Ada has a tendency to accuse others loudly.",
      "Dmitri has been silent, which is suspicious.",
      "Esme hasn't spoken much so far.",
      "Ada seems most likely Mafia due to her lack of interaction with others.",
    ]) {
      const out = cleanNightReason(bad, "kill", "Boris");
      expect(out).toBe("Boris looks like a strong early threat, so we remove them.");
      expect(hasBadMarker(out)).toBe(false);
    }
  });

  it("uses the right fallback per night action", () => {
    expect(cleanNightReason("their silence", "save", "Ada")).toBe("Protecting Ada, a plausible target for the Mafia.");
    expect(cleanNightReason("most confident", "investigate", "Cleo")).toBe("Investigating Cleo to start gathering information.");
  });

  it("replaces reasoning that code-switches into Chinese", () => {
    const out = cleanNightReason("Cleo 看起来很可疑，所以我们除掉她。", "kill", "Cleo");
    expect(out).toBe("Cleo looks like a strong early threat, so we remove them.");
    expect(hasNonEnglish(out)).toBe(false);
  });

  it("rejects third-person self-narration on a self-save and uses a first-person line", () => {
    // The exact leak seen live: a Doctor saving itself echoes its persona blurb in the third person.
    const out = cleanNightReason(
      "Felix is the prosecutor and demands hard evidence, making him a likely target",
      "save",
      "Felix", // target == self (Doctor guarding itself)
      "Felix",
    );
    expect(out).toBe("Guarding myself this round — I am a plausible target for the Mafia.");
    expect(refersToSelfInThirdPerson(out, "Felix")).toBe(false);
  });

  it("keeps the third-person target line when the actor is NOT the target", () => {
    // Narrating ANOTHER seat in the third person is fine — only self-narration is scrubbed.
    const r = "Cleo is the loudest Town voice, so she is the safest kill.";
    expect(cleanNightReason(r, "kill", "Cleo", "Boris")).toBe(r);
  });
});
