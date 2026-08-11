import type { HexSettings, Transcript } from "./types";

const FILLER_PATTERN = /(?:^|[\s,])(?:uh+|um+|erm+|hmm+)(?:[,\s]+|(?=$|[.!?]))/gi;

export function formatTranscript(input: string, settings: HexSettings): string {
  let text = input.trim().replace(/\s+/g, " ");

  if (settings.removeFillers) {
    text = text.replace(FILLER_PATTERN, " ").replace(/\s+/g, " ").trim();
  }
  if (settings.removePunctuation) {
    text = text.replace(/[.,!?;:…—–]/g, "").replace(/\s+/g, " ").trim();
  }
  if (settings.lowercase) {
    text = text.toLocaleLowerCase();
  }

  return text;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function formatTranscriptMeta(
  transcript: Pick<Transcript, "duration" | "processingDuration" | "backend">,
) {
  const parts = [`${formatDuration(transcript.duration)} audio`];
  if (typeof transcript.processingDuration === "number") {
    parts.push(`${formatDuration(transcript.processingDuration)} processing`);
  }
  if (transcript.backend) {
    parts.push(transcript.backend === "webgpu" ? "GPU" : "CPU");
  }
  return parts.join(" · ");
}

export function relativeTime(iso: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(iso).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Yesterday" : `${days}d ago`;
}
