export type Page = "home" | "history" | "settings" | "about";

export type ModelId =
  | "native/parakeet-tdt-0.6b-v3"
  | "native/sensevoice-small-int8";
export type UiLanguage = "en" | "pl" | "zh-Hans";
export type InferenceBackend = "native";

export interface TranscriptionResult {
  text: string;
  inferenceDuration: number;
  backend: InferenceBackend;
  segmentCount?: number;
}

export interface HexSettings {
  hotkey: string;
  pasteLastHotkey: string;
  model: ModelId;
  uiLanguage: UiLanguage;
  microphoneId: string;
  doubleTapLock: boolean;
  minimumKeyTime: number;
  launchAtLogin: boolean;
  soundEffects: boolean;
  pasteWithClipboard: boolean;
  copyToClipboard: boolean;
  saveHistory: boolean;
  maxHistory: number;
  removeFillers: boolean;
  lowercase: boolean;
  removePunctuation: boolean;
}

export interface Transcript {
  id: string;
  text: string;
  createdAt: string;
  duration: number;
  processingDuration?: number;
  inferenceDuration?: number;
  backend?: InferenceBackend;
  segmentCount?: number;
  modelId?: ModelId;
}

export type RecordingStatus =
  | "idle"
  | "recording"
  | "locked"
  | "loading"
  | "transcribing"
  | "inserting";

export interface ModelProgress {
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}
