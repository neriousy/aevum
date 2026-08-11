import { describe, expect, it } from "vitest";
import { splitSpeechAtPauses } from "./speech-segmentation";

const SAMPLE_RATE = 16_000;

function tone(seconds: number, amplitude = 0.1) {
  const output = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Math.sin((index / SAMPLE_RATE) * Math.PI * 2 * 220) * amplitude;
  }
  return output;
}

function join(...parts: Float32Array[]) {
  const output = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

describe("splitSpeechAtPauses", () => {
  it("does not split ordinary short pauses", () => {
    const audio = join(tone(0.8), new Float32Array(SAMPLE_RATE * 0.3), tone(0.8));
    expect(splitSpeechAtPauses(audio)).toHaveLength(1);
  });

  it("splits distinct utterances separated by a natural pause", () => {
    const audio = join(tone(0.8), new Float32Array(SAMPLE_RATE), tone(0.8));
    const segments = splitSpeechAtPauses(audio);
    expect(segments).toHaveLength(2);
    expect(segments[0].endSeconds).toBeLessThan(segments[1].startSeconds);
  });

  it("skips effectively silent recordings", () => {
    expect(splitSpeechAtPauses(new Float32Array(SAMPLE_RATE))).toEqual([]);
  });
});
