import { describe, expect, it } from "vitest";
import { createTranslator, UI_LANGUAGES } from "./i18n";

describe("interface localization", () => {
  it("offers English, Polish, and Simplified Chinese", () => {
    expect(UI_LANGUAGES.map((language) => language.id)).toEqual(["en", "pl", "zh-Hans"]);
  });

  it("interpolates Simplified Chinese messages", () => {
    const t = createTranslator("zh-Hans");
    expect(t("updates.available", { version: "1.2.3" })).toBe("Aevum 1.2.3 已发布。");
    expect(t("model.downloadingFile", { file: "model.onnx" })).toBe(
      "正在下载 model.onnx",
    );
  });
});
