import {
  LogitsProcessor,
  LogitsProcessorList,
  pipeline,
} from "@huggingface/transformers";

const SAMPLES = [
  {
    expected: "en",
    url: "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav",
  },
  {
    expected: "pl",
    url: "https://huggingface.co/datasets/s512757/polish-tedx-asr-eval/resolve/main/audio/s485936_tts_sample_000.wav",
  },
];

class AutomaticWhisperPrefix extends LogitsProcessor {
  constructor(languageIds, transcribeId, noTimestampsId) {
    super();
    this.languageIds = languageIds;
    this.transcribeId = transcribeId;
    this.noTimestampsId = noTimestampsId;
  }

  _call(inputIds, logits) {
    const allValues = logits.data;
    const vocabularySize = logits.dims.at(-1) ?? allValues.length;
    for (let batch = 0; batch < inputIds.length; batch += 1) {
      const values = allValues.subarray(batch * vocabularySize, (batch + 1) * vocabularySize);
      if (inputIds[batch].length === 1) {
        for (let token = 0; token < values.length; token += 1) {
          if (!this.languageIds.has(token)) values[token] = -Infinity;
        }
      } else if (inputIds[batch].length === 2) {
        values.fill(-Infinity);
        values[this.transcribeId] = 0;
      } else if (inputIds[batch].length === 3) {
        values.fill(-Infinity);
        values[this.noTimestampsId] = 0;
      }
    }
    return logits;
  }
}

function decodeWav(buffer) {
  const view = new DataView(buffer);
  let format;
  let channels;
  let sampleRate;
  let bits;
  let dataOffset;
  let dataLength;
  for (let offset = 12; offset + 8 <= view.byteLength; ) {
    const id = String.fromCharCode(...new Uint8Array(buffer, offset, 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      format = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (format !== 1 || bits !== 16 || !channels || !sampleRate || !dataOffset || !dataLength) {
    throw new Error("The verification samples must be 16-bit PCM WAV files.");
  }
  const frames = Math.floor(dataLength / 2 / channels);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let value = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      value += view.getInt16(dataOffset + (frame * channels + channel) * 2, true) / 32768;
    }
    mono[frame] = value / channels;
  }
  if (sampleRate === 16_000) return mono;
  const output = new Float32Array(Math.round((mono.length * 16_000) / sampleRate));
  for (let index = 0; index < output.length; index += 1) {
    output[index] = mono[Math.min(mono.length - 1, Math.floor((index * sampleRate) / 16_000))];
  }
  return output;
}

const transcriber = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny", {
  dtype: "q4",
});
const config = transcriber.model.generation_config;
const languageEntries = Object.entries(config.lang_to_id);
const languageByToken = new Map(languageEntries.map(([language, token]) => [token, language.slice(2, -2)]));

for (const sample of SAMPLES) {
  const audio = decodeWav(await (await fetch(sample.url)).arrayBuffer());
  const processors = new LogitsProcessorList();
  processors.push(
    new AutomaticWhisperPrefix(
      new Set(languageEntries.map(([, token]) => token)),
      config.task_to_id.transcribe,
      config.no_timestamps_token_id,
    ),
  );
  const features = await transcriber.processor(audio);
  const startedAt = performance.now();
  const generated = await transcriber.model.generate({
    inputs: features.input_features,
    decoder_input_ids: [config.decoder_start_token_id],
    logits_processor: processors,
    return_timestamps: false,
    max_new_tokens: Math.min(128, Math.max(16, Math.ceil(audio.length / 16_000) * 8)),
  });
  const tokens = generated.tolist()[0].map(Number);
  const language = languageByToken.get(tokens[1]);
  const text = transcriber.tokenizer.decode(tokens, { skip_special_tokens: true }).trim();
  const processingSeconds = (performance.now() - startedAt) / 1000;
  console.log(JSON.stringify({ expected: sample.expected, language, processingSeconds, text }));
  if (language !== sample.expected || !text) process.exitCode = 1;
}

await transcriber.dispose();
