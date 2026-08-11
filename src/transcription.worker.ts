/// <reference lib="webworker" />

import { env, pipeline } from "@huggingface/transformers";
import type { InferenceBackend, InferenceDevice } from "./types";

env.allowLocalModels = false;
env.useBrowserCache = true;

const SAMPLE_RATE = 16_000;
const MAX_CHUNK_SECONDS = 30;
const WARMUP_GENERATION_TOKENS = 24;
const WARMUP_AUDIO = new Float32Array(SAMPLE_RATE);

let transcriber: any;
let activeModel = "";
let activeDevice: InferenceDevice = "auto";
let activeBackend: InferenceBackend = "wasm";
let loadingJob: Promise<void> | null = null;

interface GpuAdapterLike {
  features: { has(name: string): boolean };
}

interface GpuLike {
  requestAdapter(options?: { powerPreference?: "high-performance" }): Promise<GpuAdapterLike | null>;
}

function progressCallback(model: string) {
  return (progress: unknown) => {
    self.postMessage({ type: "progress", model, progress });
  };
}

async function hasWebGpu() {
  const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
  if (!gpu) return false;
  try {
    return Boolean(await gpu.requestAdapter({ powerPreference: "high-performance" }));
  } catch {
    return false;
  }
}

async function warmUp(candidate: any) {
  await candidate(WARMUP_AUDIO, {
    task: "transcribe",
    language: "english",
    return_timestamps: false,
    // Whisper decodes one token at a time. WebGPU may compile new programs as
    // the decoder cache grows, so a one-token warm-up still leaves those costs
    // on the first real dictations. Exercise a representative short phrase now.
    min_new_tokens: WARMUP_GENERATION_TOKENS,
    max_new_tokens: WARMUP_GENERATION_TOKENS,
  });
}

async function disposePipeline(candidate: any) {
  try {
    await candidate?.dispose?.();
  } catch {
    // A failed accelerator session must not prevent the compatible fallback.
  }
}

async function loadPipeline(model: string, device: InferenceDevice) {
  const onProgress = progressCallback(model);
  const gpuAvailable = device !== "wasm" && (await hasWebGpu());

  if (device === "webgpu" && !gpuAvailable) {
    throw new Error(
      "GPU acceleration is unavailable. Choose Automatic or CPU in Settings, or update the graphics driver.",
    );
  }

  if (gpuAvailable) {
    let candidate: any;
    try {
      candidate = await pipeline("automatic-speech-recognition", model, {
        device: "webgpu",
        dtype: "q4",
        progress_callback: onProgress,
      });
      await warmUp(candidate);
      return { candidate, backend: "webgpu" as const };
    } catch (error) {
      await disposePipeline(candidate);
      if (device === "webgpu") {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`GPU acceleration could not start: ${message}`);
      }
    }
  }

  const candidate = await pipeline("automatic-speech-recognition", model, {
    device: "wasm",
    dtype: "q4",
    progress_callback: onProgress,
  });
  await warmUp(candidate);
  return { candidate, backend: "wasm" as const };
}

async function prepare(model: string, device: InferenceDevice, announce = true) {
  if (transcriber && activeModel === model && activeDevice === device) {
    if (announce) {
      self.postMessage({ type: "ready", model, device, backend: activeBackend });
    }
    return;
  }

  if (loadingJob) await loadingJob;
  if (transcriber && activeModel === model && activeDevice === device) {
    if (announce) {
      self.postMessage({ type: "ready", model, device, backend: activeBackend });
    }
    return;
  }

  const job = (async () => {
    const loaded = await loadPipeline(model, device);
    const previous = transcriber;
    transcriber = loaded.candidate;
    activeModel = model;
    activeDevice = device;
    activeBackend = loaded.backend;
    self.postMessage({ type: "ready", model, device, backend: activeBackend });
    if (previous && previous !== transcriber) {
      await disposePipeline(previous);
    }
  })();

  loadingJob = job;
  try {
    await job;
  } finally {
    if (loadingJob === job) loadingJob = null;
  }
}

function maxNewTokens(audio: Float32Array) {
  const audioSeconds = audio.length / SAMPLE_RATE;
  return Math.min(256, Math.max(12, Math.ceil(audioSeconds * 6) + 8));
}

self.onmessage = async (event: MessageEvent) => {
  const { type, id, model, audio, language, device = "auto" } = event.data as {
    type: "prepare" | "transcribe";
    id?: string;
    model: string;
    audio?: Float32Array;
    language?: string;
    device?: InferenceDevice;
  };

  try {
    if (type === "prepare") {
      await prepare(model, device);
      return;
    }
    if (type === "transcribe") {
      await prepare(model, device, false);
      if (!transcriber || activeModel !== model || activeDevice !== device || !audio) {
        throw new Error("The transcription engine changed while it was preparing. Try again.");
      }

      const options: Record<string, unknown> = {
        task: "transcribe",
        language,
        return_timestamps: false,
        max_new_tokens: maxNewTokens(audio),
      };
      if (audio.length > SAMPLE_RATE * MAX_CHUNK_SECONDS) {
        options.chunk_length_s = MAX_CHUNK_SECONDS;
        options.stride_length_s = 5;
      }

      const startedAt = performance.now();
      const output = await transcriber(audio, options);
      const inferenceMs = performance.now() - startedAt;
      self.postMessage({
        type: "result",
        id,
        text: output.text ?? "",
        inferenceMs,
        backend: activeBackend,
      });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      id,
      model,
      device,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
