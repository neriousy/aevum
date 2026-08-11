import type { HexSettings, ModelId, Transcript } from "./types";

export const PARAKEET_MODEL = {
  id: "native/parakeet-tdt-0.6b-v3",
  name: "Parakeet V3",
  size: "456 MB",
  description:
    "Fast native transcription with automatic detection for 25 European languages.",
} as const;

export const SENSEVOICE_MODEL = {
  id: "native/sensevoice-small-int8",
  name: "SenseVoiceSmall Q8",
  size: "153 MB",
  description:
    "Optional specialist model for Chinese, Cantonese, Japanese, Korean, and English.",
} as const;

export const MODELS = [PARAKEET_MODEL, SENSEVOICE_MODEL] as const;

export const DEFAULT_SETTINGS: HexSettings = {
  hotkey: "Ctrl+Shift+Space",
  pasteLastHotkey: "Ctrl+Alt+V",
  model: PARAKEET_MODEL.id,
  uiLanguage: "en",
  microphoneId: "default",
  doubleTapLock: true,
  handsFreeSilenceStop: true,
  minimumKeyTime: 0.2,
  launchAtLogin: false,
  soundEffects: true,
  pasteWithClipboard: true,
  copyToClipboard: false,
  saveHistory: true,
  maxHistory: 100,
  removeFillers: false,
  lowercase: false,
  removePunctuation: false,
};

const SETTINGS_KEY = "hex.windows.settings.v1";
const HISTORY_KEY = "hex.windows.history.v1";
const PREPARED_MODELS_KEY = "hex.windows.prepared-models";
const LEGACY_PREPARED_MODEL_KEY = "hex.windows.prepared-model";

export function loadSettings(): HexSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<HexSettings>;
    const candidate = { ...DEFAULT_SETTINGS, ...parsed };
    const {
      hotkey,
      pasteLastHotkey,
      model: unverifiedModel,
      uiLanguage: unverifiedUiLanguage,
      microphoneId,
      doubleTapLock,
      handsFreeSilenceStop,
      minimumKeyTime,
      launchAtLogin,
      soundEffects,
      pasteWithClipboard,
      copyToClipboard,
      saveHistory,
      maxHistory,
      removeFillers,
      lowercase,
      removePunctuation,
    } = candidate;
    const model = MODELS.some((entry) => entry.id === unverifiedModel)
      ? (unverifiedModel as ModelId)
      : DEFAULT_SETTINGS.model;
    const uiLanguage = ["en", "pl", "zh-Hans"].includes(unverifiedUiLanguage)
      ? unverifiedUiLanguage as HexSettings["uiLanguage"]
      : "en";
    return {
      hotkey,
      pasteLastHotkey,
      model,
      uiLanguage,
      microphoneId,
      doubleTapLock,
      handsFreeSilenceStop,
      minimumKeyTime,
      launchAtLogin,
      soundEffects,
      pasteWithClipboard,
      copyToClipboard,
      saveHistory,
      maxHistory,
      removeFillers,
      lowercase,
      removePunctuation,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: HexSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadHistory(): Transcript[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as Transcript[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveHistory(history: Transcript[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

export function getPreparedModels(): ModelId[] {
  try {
    const stored = JSON.parse(localStorage.getItem(PREPARED_MODELS_KEY) ?? "[]") as string[];
    const legacy = localStorage.getItem(LEGACY_PREPARED_MODEL_KEY);
    return MODELS.map((model) => model.id).filter(
      (id) => stored.includes(id) || legacy === id,
    );
  } catch {
    return [];
  }
}

export function setPreparedModel(model: ModelId) {
  const prepared = new Set(getPreparedModels());
  prepared.add(model);
  localStorage.setItem(PREPARED_MODELS_KEY, JSON.stringify([...prepared]));
}
