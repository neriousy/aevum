const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320;
const SPLIT_SILENCE_FRAMES = Math.ceil(0.7 / (FRAME_SAMPLES / SAMPLE_RATE));
const PADDING_FRAMES = Math.ceil(0.12 / (FRAME_SAMPLES / SAMPLE_RATE));
const MAX_SEGMENT_FRAMES = Math.floor(25 / (FRAME_SAMPLES / SAMPLE_RATE));
const MAX_SEGMENTS = 12;

export interface SpeechSegment {
  audio: Float32Array;
  startSeconds: number;
  endSeconds: number;
}

function frameEnergy(audio: Float32Array, frame: number) {
  const start = frame * FRAME_SAMPLES;
  const end = Math.min(start + FRAME_SAMPLES, audio.length);
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += audio[index] * audio[index];
  return Math.sqrt(sum / Math.max(1, end - start));
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

export function splitSpeechAtPauses(audio: Float32Array): SpeechSegment[] {
  if (audio.length === 0) return [];
  const frameCount = Math.ceil(audio.length / FRAME_SAMPLES);
  const energies = Array.from({ length: frameCount }, (_, frame) => frameEnergy(audio, frame));
  const peak = Math.max(...energies);
  if (peak < 0.001) return [];

  const noiseFloor = percentile(energies, 0.2);
  const threshold = Math.min(peak * 0.35, Math.max(0.0015, noiseFloor * 2.8, peak * 0.08));
  const speechFrames = energies
    .map((energy, frame) => (energy >= threshold ? frame : -1))
    .filter((frame) => frame >= 0);
  if (speechFrames.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  let rangeStart = speechFrames[0];
  let lastSpeech = speechFrames[0];

  const pushRange = (start: number, end: number) => {
    let cursor = Math.max(0, start - PADDING_FRAMES);
    const paddedEnd = Math.min(frameCount, end + PADDING_FRAMES + 1);
    while (paddedEnd - cursor > MAX_SEGMENT_FRAMES) {
      ranges.push([cursor, cursor + MAX_SEGMENT_FRAMES]);
      cursor += MAX_SEGMENT_FRAMES;
    }
    ranges.push([cursor, paddedEnd]);
  };

  for (const frame of speechFrames.slice(1)) {
    if (frame - lastSpeech > SPLIT_SILENCE_FRAMES) {
      pushRange(rangeStart, lastSpeech);
      rangeStart = frame;
    }
    lastSpeech = frame;
  }
  pushRange(rangeStart, lastSpeech);

  const bounded = ranges.slice(0, MAX_SEGMENTS);
  if (ranges.length > MAX_SEGMENTS) {
    bounded[MAX_SEGMENTS - 1][1] = ranges.at(-1)![1];
  }
  return bounded.map(([startFrame, endFrame]) => {
    const start = startFrame * FRAME_SAMPLES;
    const end = Math.min(audio.length, endFrame * FRAME_SAMPLES);
    return {
      audio: audio.subarray(start, end),
      startSeconds: start / SAMPLE_RATE,
      endSeconds: end / SAMPLE_RATE,
    };
  });
}
