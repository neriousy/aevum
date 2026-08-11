/// <reference lib="webworker" />

import {
  env,
  LogitsProcessor,
  LogitsProcessorList,
  pipeline,
  type Tensor,
} from "@huggingface/transformers";
import { splitSpeechAtPauses } from "./speech-segmentation";
import type { InferenceBackend, InferenceDevice } from "./types";

env.allowLocalModels = false;
env.useBrowserCache = true;

const SAMPLE_RATE = 16_000;
const MAX_CHUNK_SECONDS = 30;
const WARMUP_GENERATION_TOKENS = 27;
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

class AutomaticWhisperPrefix extends LogitsProcessor {
  constructor(
    private readonly languageTokenIds: Set<number>,
    private readonly transcribeTokenId: number,
    private readonly noTimestampsTokenId: number,
  ) {
    super();
  }

  _call(inputIds: bigint[][], logits: Tensor) {
    const allValues = logits.data as Float32Array;
    const vocabularySize = logits.dims.at(-1) ?? allValues.length;
    for (let batch = 0; batch < inputIds.length; batch += 1) {
      const values = allValues.subarray(batch * vocabularySize, (batch + 1) * vocabularySize);
      const prefixLength = inputIds[batch].length;
      if (prefixLength === 1) {
        for (let token = 0; token < values.length; token += 1) {
          if (!this.languageTokenIds.has(token)) values[token] = -Infinity;
        }
      } else if (prefixLength === 2) {
        values.fill(-Infinity);
        values[this.transcribeTokenId] = 0;
      } else if (prefixLength === 3) {
        values.fill(-Infinity);
        values[this.noTimestampsTokenId] = 0;
      }
    }
    return logits;
  }
}

function automaticPrefix(candidate: any) {
  const config = candidate.model.generation_config;
  const languageEntries = Object.entries(config?.lang_to_id ?? {}) as Array<[string, number]>;
  const transcribeTokenId = config?.task_to_id?.transcribe;
  const noTimestampsTokenId = config?.no_timestamps_token_id;
  const decoderStartTokenId = config?.decoder_start_token_id;
  if (
    languageEntries.length === 0 ||
    typeof transcribeTokenId !== "number" ||
    typeof noTimestampsTokenId !== "number" ||
    typeof decoderStartTokenId !== "number"
  ) {
    throw new Error("This model does not expose the multilingual Whisper language tokens.");
  }

  const processor = new LogitsProcessorList();
  processor.push(
    new AutomaticWhisperPrefix(
      new Set(languageEntries.map(([, token]) => token)),
      transcribeTokenId,
      noTimestampsTokenId,
    ),
  );
  return {
    decoderStartTokenId,
    languageByToken: new Map(languageEntries.map(([language, token]) => [token, language.slice(2, -2)])),
    processor,
  };
}

async function transcribeWithAutomaticLanguage(
  candidate: any,
  audio: Float32Array,
  tokenLimit: number,
  minimumTokens?: number,
) {
  const prefix = automaticPrefix(candidate);
  const features = await candidate.processor(audio);
  const generated = (await candidate.model.generate({
    inputs: features.input_features,
    decoder_input_ids: [prefix.decoderStartTokenId],
    logits_processor: prefix.processor,
    return_timestamps: false,
    min_new_tokens: minimumTokens,
    max_new_tokens: tokenLimit + 3,
  })) as Tensor;
  const tokens = ((generated.tolist() as bigint[][])[0] ?? []).map(Number);
  const detectedLanguage = prefix.languageByToken.get(tokens[1]);
  const text = candidate.tokenizer.decode(tokens, { skip_special_tokens: true }).trim();
  return { text, detectedLanguage };
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
  // Exercise automatic language selection and every decoder-cache depth used by
  // a representative short phrase. This prevents shader compilation from
  // appearing as a random delay during the first real dictations.
  await transcribeWithAutomaticLanguage(
    candidate,
    WARMUP_AUDIO,
    WARMUP_GENERATION_TOKENS,
    WARMUP_GENERATION_TOKENS,
  );
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

      const startedAt = performance.now();
      let text = "";
      let detectedLanguages: string[] | undefined;
      if (language === "auto") {
        const segments = splitSpeechAtPauses(audio);
        const outputs = [];
        const languages = [];
        for (const segment of segments) {
          const output = await transcribeWithAutomaticLanguage(
            transcriber,
            segment.audio,
            maxNewTokens(segment.audio),
          );
          if (output.text) outputs.push(output.text);
          if (output.detectedLanguage) languages.push(output.detectedLanguage);
        }
        text = outputs.join(" ").replace(/\s+/g, " ").trim();
        detectedLanguages = [...new Set(languages)];
      } else {
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
        const output = await transcriber(audio, options);
        text = output.text ?? "";
      }
      const inferenceMs = performance.now() - startedAt;
      self.postMessage({
        type: "result",
        id,
        text,
        inferenceMs,
        backend: activeBackend,
        detectedLanguages,
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
