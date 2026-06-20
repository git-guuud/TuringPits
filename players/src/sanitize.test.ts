import { describe, it, expect } from "vitest";
import { hasBadMarker, hasNonEnglish, cleanDaySpeech, cleanNightReason, stripSpeakerLabels, isEcho, namifySeats, forbiddenNames } from "./sanitize.js";

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
      "Their lack of involvement raises concerns.",
      "Seat 1's defensive stance is telling.",
    ]) {
      expect(hasBadMarker(s)).toBe(true);
    }
  });

  it("passes clean, grounded speech (incl. affirmative 'has spoken')", () => {
    for (const s of [
      "I'm voting for seat 3 today; my read is thin so it's provisional.",
      "Seat 1 said they want to watch the vote, which makes me cautious about them.",
      "Now that everyone has spoken, I lean toward seat 2 based on their own words.",
      "I have no firm read yet and want to hear more before today's vote.",
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
});
