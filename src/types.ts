export type Page = "home" | "history" | "settings" | "about";

export type ModelId =
  | "onnx-community/whisper-tiny"
  | "onnx-community/whisper-base"
  | "onnx-community/whisper-small";

export interface HexSettings {
  hotkey: string;
  pasteLastHotkey: string;
  model: ModelId;
  language: string;
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
}

export type RecordingStatus =
  | "idle"
  | "recording"
  | "locked"
  | "loading"
  | "transcribing";

export interface WorkerProgress {
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}
