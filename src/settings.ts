import type { HexSettings, InferenceDevice, ModelId, Transcript } from "./types";

export const MODELS: Array<{
  id: ModelId;
  name: string;
  size: string;
  description: string;
}> = [
  {
    id: "onnx-community/whisper-tiny",
    name: "Whisper Tiny",
    size: "100 MB",
    description:
      "The fastest model. Downloads in moments and transcribes almost instantly, at the cost of some accuracy. Fine for short notes and quick replies.",
  },
  {
    id: "onnx-community/whisper-base",
    name: "Whisper Base",
    size: "145 MB",
    description:
      "A balanced choice. Noticeably more accurate than Tiny while still quick — the right fit for most people.",
  },
  {
    id: "onnx-community/whisper-small",
    name: "Whisper Small",
    size: "300 MB",
    description:
      "The most accurate of the three, especially for longer dictation, names, and accents. Takes longer to download and transcribe.",
  },
];

export const HOTKEYS = [
  "Ctrl+Shift+Space",
  "Alt+Shift+Space",
  "Ctrl+Alt+Space",
  "Ctrl+Shift+H",
];

export const PASTE_HOTKEYS = [
  "Ctrl+Alt+V",
  "Ctrl+Shift+V",
  "Alt+Shift+V",
  "Disabled",
];

export const INFERENCE_DEVICES: Array<{
  id: InferenceDevice;
  name: string;
  description: string;
}> = [
  {
    id: "auto",
    name: "Automatic (recommended)",
    description: "Uses the GPU when available and falls back to the CPU if acceleration cannot start.",
  },
  {
    id: "webgpu",
    name: "GPU (WebGPU)",
    description: "Forces graphics-card acceleration. Best for modern NVIDIA, AMD, and Intel GPUs.",
  },
  {
    id: "wasm",
    name: "CPU (WASM)",
    description: "Forces CPU processing. More compatible, but much slower with larger Whisper models.",
  },
];

export const LANGUAGES = [
  ["auto", "Use Windows language"],
  ["english", "English"],
  ["polish", "Polish"],
  ["german", "German"],
  ["spanish", "Spanish"],
  ["french", "French"],
  ["italian", "Italian"],
  ["portuguese", "Portuguese"],
  ["ukrainian", "Ukrainian"],
  ["japanese", "Japanese"],
  ["chinese", "Chinese"],
];

export const DEFAULT_SETTINGS: HexSettings = {
  hotkey: "Ctrl+Shift+Space",
  pasteLastHotkey: "Ctrl+Alt+V",
  model: "onnx-community/whisper-tiny",
  inferenceDevice: "auto",
  language: "auto",
  microphoneId: "default",
  doubleTapLock: true,
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
const PREPARED_MODEL_KEY = "hex.windows.prepared-model";

export function loadSettings(): HexSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<HexSettings>;
    const settings = { ...DEFAULT_SETTINGS, ...parsed };
    if (!MODELS.some((model) => model.id === settings.model)) {
      settings.model = DEFAULT_SETTINGS.model;
    }
    if (!INFERENCE_DEVICES.some((device) => device.id === settings.inferenceDevice)) {
      settings.inferenceDevice = DEFAULT_SETTINGS.inferenceDevice;
    }
    if (!LANGUAGES.some(([language]) => language === settings.language)) {
      settings.language = DEFAULT_SETTINGS.language;
    }
    return settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const SYSTEM_LANGUAGE_MAP: Record<string, string> = {
  en: "english",
  pl: "polish",
  de: "german",
  es: "spanish",
  fr: "french",
  it: "italian",
  pt: "portuguese",
  uk: "ukrainian",
  ja: "japanese",
  zh: "chinese",
};

export function resolveTranscriptionLanguage(language: string, locale = navigator.language) {
  if (language !== "auto") return language;
  const localeCode = locale.toLocaleLowerCase().split(/[-_]/)[0];
  return SYSTEM_LANGUAGE_MAP[localeCode] ?? "english";
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

export function getPreparedModel() {
  return localStorage.getItem(PREPARED_MODEL_KEY);
}

export function setPreparedModel(model: string) {
  localStorage.setItem(PREPARED_MODEL_KEY, model);
}
