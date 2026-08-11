import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MODELS, PARAKEET_MODEL, SENSEVOICE_MODEL } from "./settings";

describe("native transcription defaults", () => {
  it("uses Parakeet V3 by default and offers SenseVoice only as the CJK option", () => {
    expect(PARAKEET_MODEL.id).toBe("native/parakeet-tdt-0.6b-v3");
    expect(SENSEVOICE_MODEL.id).toBe("native/sensevoice-small-int8");
    expect(MODELS).toHaveLength(2);
    expect(DEFAULT_SETTINGS.model).toBe(PARAKEET_MODEL.id);
  });

  it("keeps language detection automatic while defaulting the interface to English", () => {
    expect(DEFAULT_SETTINGS.uiLanguage).toBe("en");
    expect(DEFAULT_SETTINGS).not.toHaveProperty("language");
    expect(DEFAULT_SETTINGS).not.toHaveProperty("inferenceDevice");
  });
});
