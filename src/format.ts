import type { HexSettings, Transcript } from "./types";
import { createTranslator } from "./i18n";
import type { UiLanguage } from "./types";

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

export function formatDuration(seconds: number, language: UiLanguage = "en"): string {
  if (seconds < 60) {
    return `${new Intl.NumberFormat(language, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function formatTranscriptMeta(
  transcript: Pick<Transcript, "duration" | "processingDuration" | "backend">,
  language: UiLanguage = "en",
) {
  const t = createTranslator(language);
  const parts = [t("meta.audio", { duration: formatDuration(transcript.duration, language) })];
  if (typeof transcript.processingDuration === "number") {
    parts.push(
      t("meta.processing", {
        duration: formatDuration(transcript.processingDuration, language),
      }),
    );
  }
  return parts.join(" · ");
}

export function relativeTime(iso: string, language: UiLanguage = "en"): string {
  const elapsed = Math.max(0, Date.now() - new Date(iso).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return createTranslator(language)("time.justNow");
  const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  return relative.format(-days, "day");
}
