import type {
  HexSettings,
  InferenceDevice,
  ModelId,
  PerformanceProfile,
  Transcript,
} from "./types";

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

export const PERFORMANCE_PROFILES: Array<{
  id: Exclude<PerformanceProfile, "custom">;
  name: string;
  description: string;
}> = [
  {
    id: "automatic",
    name: "Automatic (recommended)",
    description:
      "Chooses a model for this PC and uses the GPU when it is available, with a safe CPU fallback.",
  },
  {
    id: "fast",
    name: "Fast and lightweight",
    description: "Uses Whisper Tiny for the shortest wait and lowest memory use on older PCs.",
  },
  {
    id: "balanced",
    name: "Balanced",
    description: "Uses Whisper Base for a useful improvement in accuracy without a large slowdown.",
  },
  {
    id: "accurate",
    name: "Best accuracy",
    description: "Uses Whisper Small. Best for modern GPUs and more difficult speech.",
  },
];

export interface PerformanceCapabilities {
  logicalCores: number;
  memoryGb?: number;
  webGpu: boolean;
  gpuVendor?: string;
}

export const PROFILE_MODELS: Record<Exclude<PerformanceProfile, "automatic" | "custom">, ModelId> = {
  fast: "onnx-community/whisper-tiny",
  balanced: "onnx-community/whisper-base",
  accurate: "onnx-community/whisper-small",
};

export function recommendModel(capabilities: PerformanceCapabilities): ModelId {
  if (capabilities.logicalCores <= 4 || (capabilities.memoryGb ?? Infinity) <= 4) {
    return "onnx-community/whisper-tiny";
  }

  const vendor = capabilities.gpuVendor?.toLocaleLowerCase() ?? "";
  const likelyDiscreteGpu = /nvidia|amd|advanced micro devices/.test(vendor);
  if (capabilities.webGpu && likelyDiscreteGpu && capabilities.logicalCores >= 8) {
    return "onnx-community/whisper-small";
  }
  if (capabilities.webGpu || capabilities.logicalCores >= 8) {
    return "onnx-community/whisper-base";
  }
  return "onnx-community/whisper-tiny";
}

interface PerformanceNavigatorHints {
  deviceMemory?: number;
  gpu?: {
    requestAdapter(options?: {
      powerPreference?: "high-performance";
    }): Promise<{ info?: { vendor?: string } } | null>;
  };
}

export async function detectPerformanceCapabilities(): Promise<PerformanceCapabilities> {
  const browser = navigator as unknown as Navigator & PerformanceNavigatorHints;
  let webGpu = false;
  let gpuVendor: string | undefined;
  try {
    const adapter = await browser.gpu?.requestAdapter({ powerPreference: "high-performance" });
    webGpu = Boolean(adapter);
    gpuVendor = adapter?.info?.vendor;
  } catch {
    // Hardware probing is advisory. The transcription worker still performs its own safe fallback.
  }
  return {
    logicalCores: Math.max(1, navigator.hardwareConcurrency || 1),
    memoryGb: browser.deviceMemory,
    webGpu,
    gpuVendor,
  };
}

export const LANGUAGES = [
  ["auto", "Detect automatically"],
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
  performanceProfile: "automatic",
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
    if (
      !["automatic", "fast", "balanced", "accurate", "custom"].includes(
        settings.performanceProfile,
      )
    ) {
      settings.performanceProfile = DEFAULT_SETTINGS.performanceProfile;
    }
    if (!LANGUAGES.some(([language]) => language === settings.language)) {
      settings.language = DEFAULT_SETTINGS.language;
    }
    return settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function resolveTranscriptionLanguage(language: string) {
  return language;
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
