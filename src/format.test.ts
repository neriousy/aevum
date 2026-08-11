import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import { formatTranscript, formatTranscriptMeta } from "./format";

describe("formatTranscript", () => {
  it("normalizes whitespace", () => {
    expect(formatTranscript("  hello   world  ", DEFAULT_SETTINGS)).toBe("hello world");
  });

  it("can remove filler words", () => {
    expect(
      formatTranscript("Um, this is uh a test.", { ...DEFAULT_SETTINGS, removeFillers: true }),
    ).toBe("this is a test.");
  });

  it("can lowercase and remove punctuation", () => {
    expect(
      formatTranscript("Hello, WORLD!", {
        ...DEFAULT_SETTINGS,
        lowercase: true,
        removePunctuation: true,
      }),
    ).toBe("hello world");
  });
});

describe("formatTranscriptMeta", () => {
  it("labels legacy entries as audio duration", () => {
    expect(formatTranscriptMeta({ duration: 0.6 })).toBe("0.6s audio");
  });

  it("separates processing time from audio duration", () => {
    expect(
      formatTranscriptMeta({ duration: 0.6, processingDuration: 1.24, backend: "native" }),
    ).toBe("0.6s audio · 1.2s processing");
  });

  it("localizes transcript metadata", () => {
    expect(formatTranscriptMeta({ duration: 0.6, backend: "native" }, "pl")).toBe(
      "nagranie 0,6s",
    );
  });
});
