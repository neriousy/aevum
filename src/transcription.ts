import type { WorkerProgress } from "./types";

interface PendingRequest {
  resolve: (text: string) => void;
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
  onProgress?: (progress: WorkerProgress) => void;
  onReady?: (model: string) => void;

  constructor() {
    this.worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "progress") {
        this.onProgress?.(message.progress as WorkerProgress);
      } else if (message.type === "ready") {
        this.readyModel = message.model;
        this.onReady?.(message.model);
        this.takeReadyRequests(message.model).forEach(({ resolve }) => resolve());
      } else if (message.type === "result") {
        const pending = this.requests.get(message.id);
        pending?.resolve(message.text);
        this.requests.delete(message.id);
      } else if (message.type === "error") {
        const error = new Error(message.message);
        if (message.id) {
          this.requests.get(message.id)?.reject(error);
          this.requests.delete(message.id);
        } else if (message.model) {
          this.takeReadyRequests(message.model).forEach(({ reject }) => reject(error));
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

  async prepare(model: string): Promise<void> {
    this.model = model;
    if (this.readyModel === model) return;
    const ready = new Promise<void>((resolve, reject) => {
      const waiters = this.readyRequests.get(model) ?? [];
      waiters.push({ resolve, reject });
      this.readyRequests.set(model, waiters);
    });
    this.worker.postMessage({ type: "prepare", model });
    await ready;
  }

  async transcribe(audio: Float32Array, model: string, language: string): Promise<string> {
    if (this.readyModel !== model) await this.prepare(model);
    const id = crypto.randomUUID();
    const result = new Promise<string>((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
    });
    this.worker.postMessage({ type: "transcribe", id, model, language, audio }, [audio.buffer]);
    return result;
  }

  isReady(model: string) {
    return this.readyModel === model;
  }

  currentModel() {
    return this.model;
  }
}
