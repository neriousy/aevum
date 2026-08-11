/// <reference lib="webworker" />

import { env, pipeline } from "@huggingface/transformers";

env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber: any;
let activeModel = "";
let loadingModel = "";
let loadingJob: Promise<void> | null = null;

async function prepare(model: string) {
  if (transcriber && activeModel === model) {
    self.postMessage({ type: "ready", model });
    return;
  }
  if (loadingJob && loadingModel === model) {
    await loadingJob;
    return;
  }
  loadingModel = model;
  const job = pipeline("automatic-speech-recognition", model, {
    dtype: "q4",
    progress_callback: (progress: unknown) => {
      if (loadingModel === model) self.postMessage({ type: "progress", progress });
    },
  }).then(
    (result) => {
      if (loadingModel !== model) return;
      transcriber = result;
      activeModel = model;
      loadingModel = "";
      loadingJob = null;
      self.postMessage({ type: "ready", model });
    },
    (error) => {
      if (loadingModel !== model) return;
      loadingModel = "";
      loadingJob = null;
      throw error;
    },
  );
  loadingJob = job;
  await job;
}

self.onmessage = async (event: MessageEvent) => {
  const { type, id, model, audio, language } = event.data;
  try {
    if (type === "prepare") {
      await prepare(model);
      return;
    }
    if (type === "transcribe") {
      await prepare(model);
      if (!transcriber || activeModel !== model) {
        throw new Error("The model changed while it was loading. Try again.");
      }
      const options: Record<string, unknown> = {
        task: "transcribe",
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: false,
      };
      if (language && language !== "auto") options.language = language;
      const output = await transcriber(audio, options);
      self.postMessage({ type: "result", id, text: output.text ?? "" });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      id,
      model,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
