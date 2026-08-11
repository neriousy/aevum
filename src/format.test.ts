import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import { formatTranscript } from "./format";

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
