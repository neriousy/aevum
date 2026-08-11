import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { splitSpeechAtPauses } from "./speech-segmentation";
import type { ModelId, ModelProgress, TranscriptionResult } from "./types";

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface NativeTranscriptionResult {
  text: string;
  inferenceMs: number;
}

interface NativeModelPreparationResult {
  model: ModelId;
  requestId: number;
  activated: boolean;
}

type NativeModelPreparer = (model: ModelId) => Promise<NativeModelPreparationResult>;

function encodeTranscriptionRequest(audio: Float32Array, model: ModelId): Uint8Array {
  const payload = new Uint8Array(4 + audio.byteLength);
  const modelCode = model === "native/parakeet-tdt-0.6b-v3" ? 0 : 1;
  new DataView(payload.buffer).setUint32(0, modelCode, true);
  payload.set(new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength), 4);
  return payload;
}

export class TranscriptionEngine {
  private activeModel: ModelId | "" = "";
  private desiredModel: ModelId | "" = "";
  private nativeProgressListener?: Promise<void>;
  private requestToken = 0;
  private latestPreparation?: { model: ModelId; token: number; promise: Promise<void> };
  private readonly prepareNative: NativeModelPreparer;
  private readonly canPrepare: boolean;
  onProgress?: (progress: ModelProgress) => void;
  onReady?: (model: ModelId) => void;

  constructor(prepareNative?: NativeModelPreparer) {
    this.canPrepare = Boolean(prepareNative) || isTauri();
    this.prepareNative =
      prepareNative ??
      ((model) => invoke<NativeModelPreparationResult>("prepare_transcription_model", { model }));

    if (!prepareNative && isTauri()) {
      this.nativeProgressListener = listen<ModelProgress>(
        "transcription-model-progress",
        (event) => {
          if (!event.payload.model || event.payload.model === this.desiredModel) {
            this.onProgress?.(event.payload);
          }
        },
      ).then(() => undefined);
    }
  }

  prepare(model: ModelId): Promise<void> {
    const intentUnchanged = this.desiredModel === model;
    if (intentUnchanged && this.activeModel === model) return Promise.resolve();
    if (intentUnchanged && this.latestPreparation?.model === model) {
      return this.latestPreparation.promise;
    }
    if (!this.canPrepare) {
      return Promise.reject(
        new Error("Native transcription models are available in the installed Aevum app."),
      );
    }

    this.desiredModel = model;
    const token = ++this.requestToken;
    const operation = (async () => {
      try {
        if (this.nativeProgressListener) await this.nativeProgressListener;
        const result = await this.prepareNative(model);
        if (token !== this.requestToken || this.desiredModel !== model) return;
        if (!result.activated || result.model !== model) {
          throw new Error("The model switch was superseded before activation.");
        }
        this.activeModel = model;
        this.onReady?.(model);
      } catch (error) {
        // An obsolete request should not replace the current UI with an error.
        if (token !== this.requestToken || this.desiredModel !== model) return;
        throw error;
      } finally {
        if (this.latestPreparation?.token === token) this.latestPreparation = undefined;
      }
    })();

    this.latestPreparation = { model, token, promise: operation };
    return operation;
  }

  async transcribe(audio: Float32Array, model: ModelId): Promise<TranscriptionResult> {
    if (!this.isReady(model)) await this.prepare(model);
    if (!this.isReady(model)) {
      throw new Error("The selected transcription model is not ready yet.");
    }

    const segments = splitSpeechAtPauses(audio);
    const outputs: string[] = [];
    let inferenceMs = 0;
    for (const segment of segments) {
      const payload = encodeTranscriptionRequest(segment.audio, model);
      const result = await invoke<NativeTranscriptionResult>("transcribe_speech", payload);
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
    return this.activeModel === model && this.desiredModel === model;
  }
}
