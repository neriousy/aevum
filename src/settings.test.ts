import { describe, expect, it } from "vitest";
import { resolveTranscriptionLanguage } from "./settings";

describe("resolveTranscriptionLanguage", () => {
  it("keeps an explicitly selected spoken language", () => {
    expect(resolveTranscriptionLanguage("polish", "en-US")).toBe("polish");
  });

  it("uses the Windows locale instead of silently defaulting Polish speech to English", () => {
    expect(resolveTranscriptionLanguage("auto", "pl-PL")).toBe("polish");
  });

  it("falls back to English for an unsupported Windows locale", () => {
    expect(resolveTranscriptionLanguage("auto", "ko-KR")).toBe("english");
  });
});
