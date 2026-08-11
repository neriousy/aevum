import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { splitSpeechAtPauses } from "./speech-segmentation";
import type { ModelId, ModelProgress, TranscriptionResult } from "./types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

interface NativeTranscriptionResult {
  text: string;
  inferenceMs: number;
}

export class TranscriptionEngine {
  private activeModel: ModelId | "" = "";
  private nativeProgressListener?: Promise<void>;
  onProgress?: (progress: ModelProgress) => void;
  onReady?: (model: ModelId) => void;

  constructor() {
    if (isTauri()) {
      this.nativeProgressListener = listen<ModelProgress>(
        "transcription-model-progress",
        (event) => this.onProgress?.(event.payload),
      ).then(() => undefined);
    }
  }

  async prepare(model: ModelId): Promise<void> {
    if (this.activeModel === model) return;
    if (!isTauri()) throw new Error("Native transcription models are available in the installed Aevum app.");
    await this.nativeProgressListener;
    await invoke("prepare_transcription_model", { model });
    this.activeModel = model;
    this.onReady?.(model);
  }

  async transcribe(audio: Float32Array, model: ModelId): Promise<TranscriptionResult> {
    if (this.activeModel !== model) await this.prepare(model);
    const segments = splitSpeechAtPauses(audio);
    const outputs: string[] = [];
    let inferenceMs = 0;
    for (const segment of segments) {
      const bytes = new Uint8Array(
        segment.audio.buffer,
        segment.audio.byteOffset,
        segment.audio.byteLength,
      );
      const result = await invoke<NativeTranscriptionResult>("transcribe_speech", bytes);
      if (result.text.trim()) outputs.push(result.text.trim());
      inferenceMs += Math.max(0, Number(result.inferenceMs) || 0);
    }
    return {
      text: outputs.join(" ").replace(/\s+/g, " ").trim(),
      inferenceDuration: inferenceMs / 1000,
      backend: "native",
      segmentCount: segments.length,
    };
  }

  isReady(model: ModelId) {
    return this.activeModel === model;
  }
}
