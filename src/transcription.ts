import type {
  InferenceBackend,
  InferenceDevice,
  TranscriptionResult,
  WorkerProgress,
} from "./types";

interface PendingRequest {
  resolve: (result: TranscriptionResult) => void;
  reject: (error: Error) => void;
}

interface ReadyRequest {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class TranscriptionEngine {
  private worker = new Worker(new URL("./transcription.worker.ts", import.meta.url), {
    type: "module",
  });
  private requests = new Map<string, PendingRequest>();
  private readyRequests = new Map<string, ReadyRequest[]>();
  private model = "";
  private readyModel = "";
  private device: InferenceDevice = "auto";
  private readyDevice: InferenceDevice | "" = "";
  private backend: InferenceBackend | "" = "";
  onProgress?: (progress: WorkerProgress) => void;
  onReady?: (
    model: string,
    device: InferenceDevice,
    backend: InferenceBackend,
  ) => void;

  constructor() {
    this.worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "progress") {
        this.onProgress?.(message.progress as WorkerProgress);
      } else if (message.type === "ready") {
        this.readyModel = message.model;
        this.readyDevice = message.device;
        this.backend = message.backend;
        this.onReady?.(message.model, message.device, message.backend);
        this.takeReadyRequests(this.readyKey(message.model, message.device)).forEach(({ resolve }) =>
          resolve(),
        );
      } else if (message.type === "result") {
        const pending = this.requests.get(message.id);
        pending?.resolve({
          text: message.text,
          inferenceDuration: Math.max(0, Number(message.inferenceMs) || 0) / 1000,
          backend: message.backend === "webgpu" ? "webgpu" : "wasm",
          detectedLanguages: Array.isArray(message.detectedLanguages)
            ? message.detectedLanguages
            : undefined,
        });
        this.requests.delete(message.id);
      } else if (message.type === "error") {
        const error = new Error(message.message);
        if (message.id) {
          this.requests.get(message.id)?.reject(error);
          this.requests.delete(message.id);
        } else if (message.model && message.device) {
          this.takeReadyRequests(this.readyKey(message.model, message.device)).forEach(({ reject }) =>
            reject(error),
          );
        } else {
          this.rejectAllReady(error);
        }
      }
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "The local transcription worker stopped unexpectedly");
      this.rejectAllReady(error);
      this.requests.forEach(({ reject }) => reject(error));
      this.requests.clear();
    };
  }

  private readyKey(model: string, device: InferenceDevice) {
    return `${model}\u0000${device}`;
  }

  private takeReadyRequests(model: string) {
    const waiters = this.readyRequests.get(model) ?? [];
    this.readyRequests.delete(model);
    return waiters;
  }

  private rejectAllReady(error: Error) {
    const waiters = [...this.readyRequests.values()].flat();
    this.readyRequests.clear();
    waiters.forEach(({ reject }) => reject(error));
  }

  async prepare(model: string, device: InferenceDevice): Promise<void> {
    this.model = model;
    this.device = device;
    if (this.isReady(model, device)) return;
    const key = this.readyKey(model, device);
    const ready = new Promise<void>((resolve, reject) => {
      const waiters = this.readyRequests.get(key) ?? [];
      waiters.push({ resolve, reject });
      this.readyRequests.set(key, waiters);
    });
    this.worker.postMessage({ type: "prepare", model, device });
    await ready;
  }

  async transcribe(
    audio: Float32Array,
    model: string,
    language: string,
    device: InferenceDevice,
  ): Promise<TranscriptionResult> {
    if (!this.isReady(model, device)) await this.prepare(model, device);
    const id = crypto.randomUUID();
    const result = new Promise<TranscriptionResult>((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
    });
    this.worker.postMessage({ type: "transcribe", id, model, language, device, audio }, [
      audio.buffer,
    ]);
    return result;
  }

  isReady(model: string, device: InferenceDevice) {
    return this.readyModel === model && this.readyDevice === device;
  }

  currentModel() {
    return this.model;
  }

  currentDevice() {
    return this.device;
  }

  currentBackend() {
    return this.backend;
  }
}
