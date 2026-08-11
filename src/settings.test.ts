import { describe, expect, it } from "vitest";
import { recommendModel, resolveTranscriptionLanguage } from "./settings";

describe("resolveTranscriptionLanguage", () => {
  it("keeps an explicitly selected spoken language", () => {
    expect(resolveTranscriptionLanguage("polish")).toBe("polish");
  });

  it("preserves automatic language detection for every recording", () => {
    expect(resolveTranscriptionLanguage("auto")).toBe("auto");
  });
});

describe("recommendModel", () => {
  it("keeps low-resource PCs on Tiny", () => {
    expect(recommendModel({ logicalCores: 4, memoryGb: 8, webGpu: false })).toBe(
      "onnx-community/whisper-tiny",
    );
  });

  it("uses Small on a modern discrete GPU", () => {
    expect(
      recommendModel({ logicalCores: 16, memoryGb: 32, webGpu: true, gpuVendor: "NVIDIA" }),
    ).toBe("onnx-community/whisper-small");
  });

  it("uses Base as the middle tier", () => {
    expect(recommendModel({ logicalCores: 8, memoryGb: 16, webGpu: false })).toBe(
      "onnx-community/whisper-base",
    );
  });
});
