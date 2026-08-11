type LevelHandler = (level: number) => void;

export function playCue(kind: "start" | "stop" | "cancel") {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(
    kind === "start" ? 660 : kind === "stop" ? 520 : 230,
    now,
  );
  if (kind === "start") oscillator.frequency.exponentialRampToValueAtTime(820, now + 0.065);
  if (kind === "stop") oscillator.frequency.exponentialRampToValueAtTime(390, now + 0.075);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.075, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.095);
  oscillator.addEventListener("ended", () => void context.close(), { once: true });
}

function flatten(chunks: Float32Array[]): Float32Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Float32Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function resampleAudio(
  input: Float32Array,
  sourceRate: number,
  targetRate = 16_000,
): Float32Array {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.round(input.length / ratio));

  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const mix = position - left;
    output[index] = input[left] * (1 - mix) + input[right] * mix;
  }
  return output;
}

export class AudioCapture {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private silentGain?: GainNode;
  private chunks: Float32Array[] = [];
  private sourceRate = 16_000;
  private starting = false;

  async start(deviceId: string, onLevel: LevelHandler): Promise<void> {
    if (this.stream || this.starting) return;
    this.starting = true;
    this.chunks = [];
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId && deviceId !== "default" ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } finally {
      this.starting = false;
    }

    this.context = new AudioContext({ latencyHint: "interactive" });
    await this.context.resume();
    this.sourceRate = this.context.sampleRate;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.silentGain = this.context.createGain();
    this.silentGain.gain.value = 0;

    this.processor.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(samples);
      this.chunks.push(copy);
      let energy = 0;
      for (let index = 0; index < copy.length; index += 1) {
        energy += copy[index] * copy[index];
      }
      onLevel(Math.min(1, Math.sqrt(energy / copy.length) * 5.5));
    };

    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.context.destination);
  }

  async stop(): Promise<Float32Array> {
    const samples = flatten(this.chunks);
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") {
      await this.context.close();
    }
    this.reset();
    return resampleAudio(samples, this.sourceRate);
  }

  async cancel(): Promise<void> {
    await this.stop();
  }

  private reset() {
    this.context = undefined;
    this.stream = undefined;
    this.source = undefined;
    this.processor = undefined;
    this.silentGain = undefined;
    this.chunks = [];
  }
}
