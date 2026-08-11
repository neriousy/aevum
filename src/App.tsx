import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  register,
  unregister,
  unregisterAll,
  type ShortcutEvent,
} from "@tauri-apps/plugin-global-shortcut";
import { disable, enable } from "@tauri-apps/plugin-autostart";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { AudioCapture, playCue } from "./audio";
import { formatDuration, formatTranscript, formatTranscriptMeta, relativeTime } from "./format";
import { createTranslator, UI_LANGUAGES, type MessageKey } from "./i18n";
import {
  getPreparedModels,
  loadHistory,
  loadSettings,
  MODELS,
  saveHistory,
  saveSettings,
  setPreparedModel,
} from "./settings";
import { TranscriptionEngine } from "./transcription";
import packageInfo from "../package.json";
import type {
  HexSettings,
  InferenceBackend,
  ModelId,
  ModelProgress,
  Page,
  RecordingStatus,
  Transcript,
  UiLanguage,
} from "./types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

async function invokeIfDesktop<T>(command: string, args?: Record<string, unknown>) {
  if (!isTauri()) return undefined;
  return invoke<T>(command, args);
}

const PAGE_KEYS: Array<[Page, MessageKey]> = [
  ["home", "nav.home"],
  ["history", "nav.history"],
  ["settings", "nav.settings"],
  ["about", "nav.about"],
];

type UpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "restarting"
  | "error";

function RuneMark() {
  const gid = useId();
  return (
    <svg viewBox="252 90 520 782" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="512" y1="100" x2="512" y2="880" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffe08a" />
          <stop offset="0.5" stopColor="#f5a623" />
          <stop offset="1" stopColor="#c06a10" />
        </linearGradient>
      </defs>
      <g transform="translate(0 40)" fill={`url(#${gid})`}>
        <path d="M512 60 531 84 512 108 493 84Z" />
        <path d="M512 122 496 300 Q512 284 528 300Z" />
        <path d="M512 226 498 356 Q512 344 526 356Z" transform="rotate(90 512 470)" />
        <path d="M512 226 498 356 Q512 344 526 356Z" transform="rotate(-90 512 470)" />
        <path d="M512 262 501 360 Q512 350 523 360Z" transform="rotate(45 512 470)" />
        <path d="M512 262 501 360 Q512 350 523 360Z" transform="rotate(-45 512 470)" />
        <path d="M512 300 502 368 Q512 358 522 368Z" transform="rotate(135 512 470)" />
        <path d="M512 300 502 368 Q512 358 522 368Z" transform="rotate(-135 512 470)" />
        <path
          fillRule="evenodd"
          d="M512 300 C575 360 610 425 610 480 C610 545 566 590 512 590 C458 590 414 545 414 480 C414 425 449 360 512 300 Z M512 345 C560 395 585 440 585 480 C585 528 552 562 512 562 C472 562 439 528 439 480 C439 440 464 395 512 345 Z"
        />
        <path d="M512 428 C534 452 548 470 548 490 A36 36 0 1 1 476 490 C476 470 490 452 512 428 Z" fill="#ffd76a" />
        <path d="M512 822 497 610 Q512 626 527 610Z" />
        <path d="M368 618 C428 622 480 650 512 700 C476 664 428 646 372 644 C360 636 360 626 368 618 Z" />
        <path d="M380 742 C440 736 488 712 512 668 C480 706 436 722 384 720 C372 728 372 736 380 742 Z" />
        <g transform="translate(1024 0) scale(-1 1)">
          <path d="M368 618 C428 622 480 650 512 700 C476 664 428 646 372 644 C360 636 360 626 368 618 Z" />
          <path d="M380 742 C440 736 488 712 512 668 C480 706 436 722 384 720 C372 728 372 736 380 742 Z" />
        </g>
      </g>
    </svg>
  );
}

function Shortcut({ value }: { value: string }) {
  return (
    <span className="keys">
      {value.split("+").map((part, index) => {
        const display = part === "Super" ? "Win" : part === "Control" ? "Ctrl" : part;
        return (
          <span key={`${part}-${index}`}>
            {index > 0 && <span className="plus">+</span>}
            <kbd>{display}</kbd>
          </span>
        );
      })}
    </span>
  );
}

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Super"] as const;

function acceleratorKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (code === "Space") return "Space";
  if (code === "ArrowUp") return "Up";
  if (code === "ArrowDown") return "Down";
  if (code === "ArrowLeft") return "Left";
  if (code === "ArrowRight") return "Right";
  if (["Home", "End", "PageUp", "PageDown", "Insert"].includes(code)) return code;
  return null;
}

function heldModifiers(event: React.KeyboardEvent): string[] {
  return MODIFIER_ORDER.filter(
    (modifier) =>
      (modifier === "Ctrl" && event.ctrlKey) ||
      (modifier === "Alt" && event.altKey) ||
      (modifier === "Shift" && event.shiftKey) ||
      (modifier === "Super" && event.metaKey),
  );
}

function ShortcutRecorder({
  value,
  requireKey,
  allowDisable,
  offLabel,
  pressLabel,
  hint,
  onChange,
  onCapturing,
}: {
  value: string;
  requireKey: boolean;
  allowDisable: boolean;
  offLabel: string;
  pressLabel: string;
  hint: string;
  onChange: (next: string) => void;
  onCapturing: (capturing: boolean) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const bestModifiers = useRef<string[]>([]);

  const begin = () => {
    bestModifiers.current = [];
    setCapturing(true);
    onCapturing(true);
  };

  const finish = (next?: string) => {
    bestModifiers.current = [];
    setCapturing(false);
    onCapturing(false);
    if (next !== undefined) onChange(next);
  };

  return (
    <>
      <button
        type="button"
        className={`field shortcut-field ${capturing ? "capturing" : ""}`}
        onClick={() => {
          if (!capturing) begin();
        }}
        onBlur={() => {
          if (capturing) finish();
        }}
        onKeyDown={(event) => {
          if (!capturing) {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              begin();
            }
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") {
            finish();
            return;
          }
          if (allowDisable && (event.key === "Backspace" || event.key === "Delete")) {
            finish("Disabled");
            return;
          }
          const modifiers = heldModifiers(event);
          const key = acceleratorKey(event.code);
          if (key) {
            if (modifiers.length > 0) finish([...modifiers, key].join("+"));
            return;
          }
          if (!requireKey && modifiers.length > bestModifiers.current.length) {
            bestModifiers.current = modifiers;
          }
        }}
        onKeyUp={(event) => {
          if (!capturing || requireKey) return;
          event.preventDefault();
          event.stopPropagation();
          const remaining = heldModifiers(event);
          if (
            bestModifiers.current.length >= 2 &&
            remaining.length < bestModifiers.current.length
          ) {
            finish(bestModifiers.current.join("+"));
          }
        }}
      >
        {capturing ? pressLabel : value === "Disabled" ? offLabel : <Shortcut value={value} />}
      </button>
      {capturing && <p className="muted shortcut-hint">{hint}</p>}
    </>
  );
}

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [settings, setSettings] = useState<HexSettings>(loadSettings);
  const t = useMemo(() => createTranslator(settings.uiLanguage), [settings.uiLanguage]);
  const [history, setHistory] = useState<Transcript[]>(loadHistory);
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [meter, setMeter] = useState(0);
  const [modelProgress, setModelProgress] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [modelDetail, setModelDetail] = useState("");
  const [modelBackend, setModelBackend] = useState<InferenceBackend | "">("");
  const [processingElapsed, setProcessingElapsed] = useState(0);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [search, setSearch] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const [updateNotes, setUpdateNotes] = useState("");
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateError, setUpdateError] = useState("");

  const audio = useRef(new AudioCapture());
  const engine = useRef<TranscriptionEngine | null>(null);
  if (!engine.current) engine.current = new TranscriptionEngine();
  const recordingStartedAt = useRef(0);
  const processingStartedAt = useRef(0);
  const lastVoiceAt = useRef(0);
  const lockOnRelease = useRef(false);
  const lastShortRelease = useRef(0);
  const manualRecording = useRef(false);
  const startingRef = useRef(false);
  const releasedWhileStarting = useRef(false);
  const finishingRef = useRef(false);
  const toastTimer = useRef(0);
  const progressFiles = useRef(new Map<string, { loaded: number; total: number }>());
  const statusRef = useRef(status);
  const settingsRef = useRef(settings);
  const historyRef = useRef(history);
  const cancelRef = useRef<() => void>(() => undefined);
  const hotkeyPressRef = useRef<() => void>(() => undefined);
  const hotkeyReleaseRef = useRef<() => void>(() => undefined);
  const availableUpdateRef = useRef<Update | null>(null);

  statusRef.current = status;
  settingsRef.current = settings;
  historyRef.current = history;

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveHistory(history), [history]);
  useEffect(() => setConfirmClear(false), [page]);

  useEffect(
    () => () => {
      void availableUpdateRef.current?.close();
      availableUpdateRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (status !== "loading" && status !== "transcribing") {
      setProcessingElapsed(0);
      return;
    }
    const update = () => {
      setProcessingElapsed(Math.max(0, (performance.now() - processingStartedAt.current) / 1000));
    };
    update();
    const timer = window.setInterval(update, 200);
    return () => window.clearInterval(timer);
  }, [status]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2800);
  }, []);

  const updateIndicator = useCallback(
    (nextStatus: string, level = 0, message?: string) => {
      const labels: Record<string, MessageKey> = {
        recording: "indicator.listening",
        locked: "indicator.handsFree",
        transcribing: "indicator.transcribing",
        loading: "indicator.loading",
        inserting: "indicator.inserting",
      };
      void invokeIfDesktop("set_indicator", {
        status: nextStatus,
        level,
        message: message ?? (labels[nextStatus] ? t(labels[nextStatus]) : undefined),
      });
    },
    [t],
  );

  const refreshMicrophones = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    setMicrophones(devices.filter((device) => device.kind === "audioinput"));
  }, []);

  useEffect(() => {
    void refreshMicrophones();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshMicrophones);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshMicrophones);
  }, [refreshMicrophones]);

  const prepareModel = useCallback(async () => {
    setError("");
    setModelReady(false);
    const currentModel = MODELS.find((model) => model.id === settingsRef.current.model)!;
    setModelDetail(t("model.preparing", { model: currentModel.name }));
    progressFiles.current.clear();
    setModelProgress((value) => Math.max(2, value));
    try {
      await engine.current!.prepare(settingsRef.current.model);
    } catch (prepareError) {
      const message = prepareError instanceof Error ? prepareError.message : String(prepareError);
      setModelProgress(0);
      setModelDetail("");
      setError(t("model.downloadFailed", { message }));
    }
  }, [t]);

  useEffect(() => {
    const currentEngine = engine.current!;
    currentEngine.onProgress = (progress: ModelProgress) => {
      const progressModel =
        MODELS.find((model) => model.id === progress.model) ??
        MODELS.find((model) => model.id === settingsRef.current.model) ??
        MODELS[0];
      const file = progress.file;
      if (file) {
        if (progress.status === "progress" && Number(progress.total) > 0) {
          progressFiles.current.set(file, {
            loaded: Number(progress.loaded) || 0,
            total: Number(progress.total),
          });
        } else if (progress.status === "done") {
          const entry = progressFiles.current.get(file);
          if (entry) progressFiles.current.set(file, { loaded: entry.total, total: entry.total });
        }
        let loaded = 0;
        let total = 0;
        for (const entry of progressFiles.current.values()) {
          loaded += entry.loaded;
          total += entry.total;
        }
        if (total > 0) setModelProgress(Math.min(99, (loaded / total) * 100));
      }
      const fileName = file?.split("/").at(-1);
      setModelDetail(
        progress.status === "extracting"
          ? t("model.installing")
          : progress.status === "verifying"
            ? t("model.verifying")
            : progress.status === "loading" || progress.status === "done" || progress.status === "ready"
              ? t("model.readying")
          : fileName
            ? t("model.downloadingFile", { file: fileName })
            : t("model.preparing", { model: progressModel.name }),
      );
    };
    currentEngine.onReady = (model) => {
      setPreparedModel(model);
      setModelReady(model === settingsRef.current.model);
      setModelProgress(100);
      setModelDetail("");
      setModelBackend("native");
    };
  }, [prepareModel, t]);

  useEffect(() => {
    const ready = engine.current!.isReady(settings.model);
    setModelReady(ready);
    if (!ready) {
      progressFiles.current.clear();
      setModelProgress(0);
      setModelDetail("");
      setModelBackend("");
    }
    if (!ready && getPreparedModels().includes(settings.model)) void prepareModel();
  }, [prepareModel, settings.model]);

  const stopEscapeShortcut = useCallback(() => {
    if (isTauri()) void unregister("Escape").catch(() => undefined);
  }, []);

  const cancelRecording = useCallback(async () => {
    if (statusRef.current !== "recording" && statusRef.current !== "locked") return;
    if (finishingRef.current) return;
    finishingRef.current = true;
    try {
      await audio.current.cancel();
    } finally {
      finishingRef.current = false;
    }
    statusRef.current = "idle";
    setStatus("idle");
    setMeter(0);
    updateIndicator("hidden");
    stopEscapeShortcut();
    if (settingsRef.current.soundEffects) playCue("cancel");
    notify(t("recording.cancelled"));
  }, [notify, stopEscapeShortcut, t, updateIndicator]);
  cancelRef.current = () => void cancelRecording();

  const finishRecording = useCallback(
    async (transcribe: boolean) => {
      if (statusRef.current !== "recording" && statusRef.current !== "locked") return;
      if (finishingRef.current) return;
      finishingRef.current = true;
      try {
        const duration = Math.max(0, (performance.now() - recordingStartedAt.current) / 1000);
        setMeter(0);
        stopEscapeShortcut();
        const samples = await audio.current.stop();

        if (!transcribe || duration < settingsRef.current.minimumKeyTime) {
          statusRef.current = "idle";
          setStatus("idle");
          updateIndicator("hidden");
          return;
        }

        if (settingsRef.current.soundEffects) playCue("stop");

        const nextStatus = engine.current!.isReady(settingsRef.current.model)
          ? "transcribing"
          : "loading";
        processingStartedAt.current = performance.now();
        setProcessingElapsed(0);
        statusRef.current = nextStatus;
        setStatus(nextStatus);
        updateIndicator(nextStatus);

        try {
          const result = await engine.current!.transcribe(samples, settingsRef.current.model);
          const text = formatTranscript(result.text, settingsRef.current);
          if (!text) throw new Error(t("recording.noSpeech"));

          const processingDuration = Math.max(
            0,
            (performance.now() - processingStartedAt.current) / 1000,
          );
          const transcript: Transcript = {
            id: crypto.randomUUID(),
            text,
            createdAt: new Date().toISOString(),
            duration,
            processingDuration,
            inferenceDuration: result.inferenceDuration,
            backend: result.backend,
            segmentCount: result.segmentCount,
            modelId: settingsRef.current.model,
          };
          if (settingsRef.current.saveHistory) {
            setHistory((current) => {
              const next = [transcript, ...current];
              return settingsRef.current.maxHistory > 0
                ? next.slice(0, settingsRef.current.maxHistory)
                : next;
            });
          }

          statusRef.current = "inserting";
          setStatus("inserting");
          updateIndicator("inserting");
          await invokeIfDesktop("set_last_transcript", { text });
          if (manualRecording.current) {
            notify(text.length > 120 ? `${text.slice(0, 120)}…` : text);
          } else {
            await invokeIfDesktop("insert_text", {
              text,
              useClipboard: settingsRef.current.pasteWithClipboard,
              copyToClipboard: settingsRef.current.copyToClipboard,
            });
          }
          statusRef.current = "idle";
          setStatus("idle");
          updateIndicator("hidden");
        } catch (transcriptionError) {
          const message =
            transcriptionError instanceof Error ? transcriptionError.message : String(transcriptionError);
          setError(message);
          if (!engine.current!.isReady(settingsRef.current.model)) {
            progressFiles.current.clear();
            setModelProgress(0);
            setModelDetail("");
          }
          statusRef.current = "idle";
          setStatus("idle");
          updateIndicator("hidden");
          void invokeIfDesktop("show_main");
        }
      } finally {
        finishingRef.current = false;
      }
    },
    [notify, stopEscapeShortcut, t, updateIndicator],
  );

  const startRecording = useCallback(
    async (manual = false) => {
      if (statusRef.current !== "idle" || startingRef.current) return;
      startingRef.current = true;
      releasedWhileStarting.current = false;
      setError("");
      manualRecording.current = manual;
      try {
        await audio.current.start(settingsRef.current.microphoneId, (level) => {
          setMeter(level);
          const now = performance.now();
          if (level > 0.05) lastVoiceAt.current = now;
          if (
            statusRef.current === "locked" &&
            settingsRef.current.handsFreeSilenceStop &&
            !finishingRef.current &&
            now - lastVoiceAt.current > 3000
          ) {
            void finishRecording(true);
            return;
          }
          updateIndicator(statusRef.current === "locked" ? "locked" : "recording", level);
        });
        recordingStartedAt.current = performance.now();
        lastVoiceAt.current = recordingStartedAt.current;
        statusRef.current = "recording";
        setStatus("recording");
        updateIndicator("recording", 0.12);
        if (settingsRef.current.soundEffects) playCue("start");
        if (isTauri()) {
          void register("Escape", (event) => {
            if (event.state === "Pressed") cancelRef.current();
          }).catch(() => undefined);
        }
        startingRef.current = false;
        if (releasedWhileStarting.current) {
          releasedWhileStarting.current = false;
          if (manual) void finishRecording(true);
          else hotkeyReleaseRef.current();
        }
      } catch (recordingError) {
        const message = recordingError instanceof Error ? recordingError.message : String(recordingError);
        setError(t("recording.microphoneUnavailable", { message }));
        statusRef.current = "idle";
        setStatus("idle");
        void invokeIfDesktop("show_main");
      } finally {
        startingRef.current = false;
      }
    },
    [finishRecording, t, updateIndicator],
  );

  const handleHotkeyPress = useCallback(() => {
    if (statusRef.current === "locked") {
      void finishRecording(true);
      return;
    }
    if (statusRef.current !== "idle") return;
    const now = performance.now();
    lockOnRelease.current =
      settingsRef.current.doubleTapLock && now - lastShortRelease.current <= 300;
    void startRecording(false);
  }, [finishRecording, startRecording]);

  const handleHotkeyRelease = useCallback(() => {
    if (startingRef.current) {
      releasedWhileStarting.current = true;
      return;
    }
    if (statusRef.current !== "recording") return;
    const elapsed = (performance.now() - recordingStartedAt.current) / 1000;
    if (lockOnRelease.current) {
      lockOnRelease.current = false;
      lastShortRelease.current = 0;
      lastVoiceAt.current = performance.now();
      statusRef.current = "locked";
      setStatus("locked");
      updateIndicator("locked", meter);
      return;
    }
    if (elapsed < settingsRef.current.minimumKeyTime) {
      lastShortRelease.current = performance.now();
      void finishRecording(false);
    } else {
      lastShortRelease.current = 0;
      void finishRecording(true);
    }
  }, [finishRecording, meter, updateIndicator]);

  hotkeyPressRef.current = handleHotkeyPress;
  hotkeyReleaseRef.current = handleHotkeyRelease;

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<{ state: string }>("hold-hotkey", (event) => {
      if (event.payload.state === "Pressed") hotkeyPressRef.current();
      else hotkeyReleaseRef.current();
    });
    return () => {
      void unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const shortcut = capturingShortcut ? "" : settings.hotkey;
    void invoke("set_hold_hotkey", { shortcut }).catch((holdError) => {
      setError(t("shortcut.failed", { hotkey: settings.hotkey, message: String(holdError) }));
    });
  }, [capturingShortcut, settings.hotkey, t]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const install = async () => {
      await unregisterAll();
      if (disposed || capturingShortcut) return;
      if (settings.pasteLastHotkey !== "Disabled") {
        await register(settings.pasteLastHotkey, (event: ShortcutEvent) => {
          if (event.state !== "Pressed") return;
          const text = historyRef.current[0]?.text;
          if (text) {
            void invokeIfDesktop("insert_text", {
              text,
              useClipboard: settingsRef.current.pasteWithClipboard,
              copyToClipboard: settingsRef.current.copyToClipboard,
            });
          }
        });
      }
    };
    void install().catch((shortcutError) => {
      setError(
        t("shortcut.failed", { hotkey: settings.pasteLastHotkey, message: String(shortcutError) }),
      );
    });
    return () => {
      disposed = true;
      void unregisterAll();
    };
  }, [capturingShortcut, settings.pasteLastHotkey, t]);

  const openLink = (url: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isTauri()) return;
    event.preventDefault();
    void invoke("open_external", { url }).catch(() => undefined);
  };

  const requestMicrophone = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      await refreshMicrophones();
      notify(t("recording.microphoneReady"));
    } catch (permissionError) {
      setError(t("recording.permissionDenied", { message: String(permissionError) }));
    }
  }, [notify, refreshMicrophones, t]);

  const updateSetting = useCallback(<K extends keyof HexSettings>(key: K, value: HexSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  }, []);

  const updateLaunchAtLogin = useCallback(
    async (value: boolean) => {
      updateSetting("launchAtLogin", value);
      if (!isTauri()) return;
      try {
        if (value) await enable();
        else await disable();
      } catch (autostartError) {
        updateSetting("launchAtLogin", !value);
        setError(t("startup.failed", { message: String(autostartError) }));
      }
    },
    [t, updateSetting],
  );

  const onRecordPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    lockOnRelease.current = false;
    void startRecording(true);
  };

  const onRecordPointerUp = () => {
    if (startingRef.current) {
      releasedWhileStarting.current = true;
      return;
    }
    if (statusRef.current === "recording") void finishRecording(true);
  };

  const copyTranscript = async (text: string) => {
    await invokeIfDesktop("copy_text", { text });
    if (!isTauri()) await navigator.clipboard?.writeText(text);
    notify(t("clipboard.copied"));
  };

  const checkForUpdates = useCallback(async () => {
    setUpdateError("");
    setUpdateProgress(0);
    if (!isTauri()) {
      setUpdatePhase("error");
      setUpdateError(t("updates.desktopOnly"));
      return;
    }

    setUpdatePhase("checking");
    try {
      await availableUpdateRef.current?.close();
      availableUpdateRef.current = null;
      const update = await check({ timeout: 15_000 });
      if (!update) {
        setUpdateVersion("");
        setUpdateNotes("");
        setUpdatePhase("current");
        return;
      }
      availableUpdateRef.current = update;
      setUpdateVersion(update.version);
      setUpdateNotes(update.body?.trim() ?? "");
      setUpdatePhase("available");
    } catch (updateCheckError) {
      setUpdatePhase("error");
      setUpdateError(
        updateCheckError instanceof Error ? updateCheckError.message : String(updateCheckError),
      );
    }
  }, [t]);

  const installUpdate = useCallback(async () => {
    const update = availableUpdateRef.current;
    if (!update) return;
    setUpdateError("");
    setUpdateProgress(0);
    setUpdatePhase("downloading");
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setUpdateProgress(total > 0 ? Math.min(100, (downloaded / total) * 100) : 0);
        } else if (event.event === "Finished") {
          setUpdateProgress(100);
        }
      });
      setUpdatePhase("restarting");
      await relaunch();
    } catch (updateInstallError) {
      setUpdatePhase("error");
      setUpdateError(
        updateInstallError instanceof Error
          ? updateInstallError.message
          : String(updateInstallError),
      );
    }
  }, []);

  const currentModel = MODELS.find((model) => model.id === settings.model) ?? MODELS[0];
  const currentModelDescription = t(
    currentModel.id === MODELS[0].id ? "model.parakeetDescription" : "model.senseDescription",
  );
  const filteredHistory = history.filter((item) =>
    item.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const todayCount = history.filter(
    (item) => new Date(item.createdAt).toDateString() === new Date().toDateString(),
  ).length;
  const totalMinutes = history.reduce((total, item) => total + item.duration, 0) / 60;
  const recording = status === "recording" || status === "locked";
  const preparing = !modelReady && modelProgress > 0;
  const backendLabel = modelBackend === "native" ? t("status.nativeCpu") : "";
  const elapsedLabel = formatDuration(processingElapsed, settings.uiLanguage);

  const statusText = recording
    ? status === "locked"
      ? t("status.handsFree", { hotkey: settings.hotkey.replaceAll("Super", "Win") })
      : t("status.listening")
    : status === "transcribing"
      ? t("status.transcribing", { elapsed: elapsedLabel })
      : status === "loading"
        ? t("status.loading", { elapsed: elapsedLabel })
        : status === "inserting"
          ? t("status.inserting")
          : modelReady
            ? t("status.ready", { backend: backendLabel ? ` · ${backendLabel}` : "" })
            : "";

  const statusClass = recording
    ? "status-live"
    : status === "transcribing" || status === "loading" || status === "inserting"
      ? "status-busy"
      : "status-ready";

  const progressLine = `${
    modelDetail || t("model.preparing", { model: currentModel.name })
  } — ${Math.round(modelProgress)}%`;

  return (
    <div className="app">
      {isTauri() && (
        <div className="titlebar" data-tauri-drag-region>
          <div className="titlebar-brand" data-tauri-drag-region>
            <RuneMark />
            <span data-tauri-drag-region>Aevum</span>
          </div>
          <div className="titlebar-controls">
            <button
              type="button"
              aria-label={t("window.minimize")}
              onClick={() => void getCurrentWindow().minimize()}
            >
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0 5h10" stroke="currentColor" strokeWidth="1.1" fill="none" />
              </svg>
            </button>
            <button
              type="button"
              aria-label={t("window.maximize")}
              onClick={() => void getCurrentWindow().toggleMaximize()}
            >
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1.1" fill="none" />
              </svg>
            </button>
            <button
              type="button"
              className="titlebar-close"
              aria-label={t("window.close")}
              onClick={() => void getCurrentWindow().close()}
            >
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0 0 10 10 M10 0 0 10" stroke="currentColor" strokeWidth="1.1" fill="none" />
              </svg>
            </button>
          </div>
        </div>
      )}
      <div className="app-scroll">
      <div className="container">
        <header>
          <h1>
            <RuneMark />
            Aevum
          </h1>
          <p className="tagline">{t("tagline")}</p>
          <nav>
            {PAGE_KEYS.map(([id, label]) => (
              <button
                type="button"
                key={id}
                className={page === id ? "active" : ""}
                onClick={() => setPage(id)}
              >
                {t(label)}
              </button>
            ))}
          </nav>
        </header>

        {error && (
          <p className="error">
            {error}{" "}
            <button type="button" className="link" onClick={() => setError("")}>
              {t("common.dismiss")}
            </button>
          </p>
        )}

        {page === "home" && (
          <>
            {statusText && (
              <p className={`status ${statusClass}`}>
                <span className="dot" />
                {statusText}
              </p>
            )}
            <p>
              {t("home.instructionsBefore")} <Shortcut value={settings.hotkey} />{" "}
              {t("home.instructionsAfter")} <kbd>Esc</kbd> {t("home.instructionsEnd")}
            </p>
            {!modelReady &&
              (preparing ? (
                <p className="muted">{progressLine}</p>
              ) : (
                <>
                  <p>
                    {t("home.firstDownload", {
                      model: currentModel.name,
                      size: currentModel.size,
                    })}
                  </p>
                  <button type="button" className="button primary" onClick={() => void prepareModel()}>
                    {t("home.downloadModel", { model: currentModel.name })}
                  </button>
                </>
              ))}
            <button
              type="button"
              className="button"
              onPointerDown={onRecordPointerDown}
              onPointerUp={onRecordPointerUp}
              onPointerCancel={onRecordPointerUp}
              onKeyDown={(event) => {
                if (event.repeat || (event.key !== " " && event.key !== "Enter")) return;
                event.preventDefault();
                lockOnRelease.current = false;
                void startRecording(true);
              }}
              onKeyUp={(event) => {
                if (event.key !== " " && event.key !== "Enter") return;
                event.preventDefault();
                onRecordPointerUp();
              }}
            >
              {recording
                ? t("home.listenRelease")
                : status === "transcribing" || status === "loading" || status === "inserting"
                  ? status === "inserting"
                    ? t("status.inserting")
                    : t("status.transcribingShort")
                  : t("home.tryHere")}
            </button>
            {history.length > 0 && (
              <>
                <p className="muted">
                  {todayCount === 0
                    ? t("home.noToday")
                    : todayCount === 1
                      ? t("home.oneToday")
                      : t("home.manyToday", { count: todayCount })}
                  {" · "}
                  {totalMinutes < 1
                    ? t("home.lessMinute")
                    : t("home.minutes", { count: totalMinutes.toFixed(1) })}
                </p>
                <h2>{t("home.recent")}</h2>
                {history.slice(0, 3).map((item) => (
                  <div className="entry" key={item.id}>
                    <p className="entry-text">{item.text}</p>
                    <p className="meta">
                      {relativeTime(item.createdAt, settings.uiLanguage)} · {formatTranscriptMeta(item, settings.uiLanguage)} ·{" "}
                      <button type="button" className="link" onClick={() => void copyTranscript(item.text)}>
                        {t("common.copy")}
                      </button>
                    </p>
                  </div>
                ))}
                <button type="button" className="link" onClick={() => setPage("history")}>
                  {t("home.seeHistory")}
                </button>
              </>
            )}
          </>
        )}

        {page === "history" && (
          <>
            {history.length === 0 ? (
              <p className="muted">
                {t("history.empty")}
              </p>
            ) : (
              <>
                <p className="muted">
                  {history.length === 1
                    ? t("history.one")
                    : t("history.many", { count: history.length })}
                </p>
                <input
                  className="field"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("history.search")}
                  aria-label={t("history.search")}
                />
                {filteredHistory.length === 0 ? (
                  <p className="muted">{t("history.noMatches")}</p>
                ) : (
                  filteredHistory.map((item) => (
                    <div className="entry" key={item.id}>
                      <p className="entry-text">{item.text}</p>
                      <p className="meta">
                        {relativeTime(item.createdAt, settings.uiLanguage)} · {formatTranscriptMeta(item, settings.uiLanguage)} ·{" "}
                        <button type="button" className="link" onClick={() => void copyTranscript(item.text)}>
                          {t("common.copy")}
                        </button>{" "}
                        ·{" "}
                        <button
                          type="button"
                          className="link"
                          onClick={() =>
                            setHistory((current) => current.filter((entry) => entry.id !== item.id))
                          }
                        >
                          {t("common.delete")}
                        </button>
                      </p>
                    </div>
                  ))
                )}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    if (!confirmClear) {
                      setConfirmClear(true);
                      return;
                    }
                    setHistory([]);
                    setSearch("");
                    setConfirmClear(false);
                  }}
                >
                  {confirmClear ? t("history.clearConfirm") : t("history.clear")}
                </button>
              </>
            )}
          </>
        )}

        {page === "settings" && (
          <>
            <h2>{t("settings.interface")}</h2>
            <label className="stack">
              {t("settings.appLanguage")}
              <select
                className="field"
                value={settings.uiLanguage}
                onChange={(event) =>
                  updateSetting("uiLanguage", event.target.value as UiLanguage)
                }
              >
                {UI_LANGUAGES.map((language) => (
                  <option key={language.id} value={language.id}>
                    {t(language.labelKey)}
                  </option>
                ))}
              </select>
            </label>

            <h2>{t("settings.model")}</h2>
            <label className="stack">
              {t("settings.modelLabel")}
              <select
                className="field"
                value={settings.model}
                disabled={status !== "idle"}
                onChange={(event) => updateSetting("model", event.target.value as ModelId)}
              >
                {MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                    {model.id === MODELS[0].id
                      ? ` — ${t("settings.recommended")}`
                      : ` — ${t("settings.optionalCjk")}`}
                  </option>
                ))}
              </select>
            </label>
            <p>
              <strong>{currentModel.name}</strong> — {currentModel.size}. {currentModelDescription}
            </p>
            <p className="muted">
              {t("settings.modelInfo")}
            </p>
            {!modelReady &&
              (preparing ? (
                <p className="muted">{progressLine}</p>
              ) : (
                <button type="button" className="button primary" onClick={() => void prepareModel()}>
                  {t("home.downloadModel", { model: currentModel.name })}
                </button>
              ))}

            <h2>{t("settings.languages")}</h2>
            {settings.model === MODELS[0].id ? (
              <>
                <p className="muted">
                  {t("settings.parakeetLanguages")}
                </p>
                <p className="muted">
                  {t("settings.parakeetSupported")}
                </p>
              </>
            ) : (
              <p className="muted">
                {t("settings.senseLanguages")}
              </p>
            )}

            <h2>{t("settings.microphone")}</h2>
            <select
              className="field"
              aria-label={t("settings.microphone")}
              value={settings.microphoneId}
              onChange={(event) => updateSetting("microphoneId", event.target.value)}
            >
              <option value="default">{t("settings.systemDefault")}</option>
              {microphones
                .filter((device) => device.deviceId !== "default")
                .map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || t("settings.microphoneNumber", { number: index + 1 })}
                  </option>
                ))}
            </select>
            {microphones.every((device) => !device.label) && (
              <p className="muted">
                <button type="button" className="link" onClick={() => void requestMicrophone()}>
                  {t("settings.allowMicrophone")}
                </button>{" "}
                {t("settings.devicesByName")}
              </p>
            )}

            <h2>{t("settings.shortcuts")}</h2>
            <p className="muted">
              {t("settings.shortcutsInfo")}
            </p>
            <div className="stack">
              {t("settings.startStop")}
              <ShortcutRecorder
                value={settings.hotkey}
                requireKey={false}
                allowDisable={false}
                offLabel={t("common.off")}
                pressLabel={t("shortcut.press")}
                hint={t("shortcut.hintHold")}
                onChange={(next) => updateSetting("hotkey", next)}
                onCapturing={setCapturingShortcut}
              />
            </div>
            <div className="stack">
              {t("settings.pasteLast")}
              <ShortcutRecorder
                value={settings.pasteLastHotkey}
                requireKey
                allowDisable
                offLabel={t("common.off")}
                pressLabel={t("shortcut.press")}
                hint={t("shortcut.hintPaste")}
                onChange={(next) => updateSetting("pasteLastHotkey", next)}
                onCapturing={setCapturingShortcut}
              />
            </div>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.doubleTapLock}
                onChange={(event) => updateSetting("doubleTapLock", event.target.checked)}
              />
              <span>{t("settings.doubleTap")}</span>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.handsFreeSilenceStop}
                onChange={(event) => updateSetting("handsFreeSilenceStop", event.target.checked)}
              />
              <span>{t("settings.handsFreeSilence")}</span>
            </label>
            <label className="stack">
              {t("settings.ignoreTaps", { seconds: settings.minimumKeyTime.toFixed(1) })}
              <input
                className="range"
                type="range"
                min="0.1"
                max="1"
                step="0.1"
                value={settings.minimumKeyTime}
                onChange={(event) => updateSetting("minimumKeyTime", Number(event.target.value))}
              />
            </label>

            <h2>{t("settings.output")}</h2>
            <p className="muted">{t("settings.outputInfo")}</p>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.pasteWithClipboard}
                onChange={(event) => updateSetting("pasteWithClipboard", event.target.checked)}
              />
              <span>{t("settings.clipboardInsert")}</span>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.copyToClipboard}
                onChange={(event) => updateSetting("copyToClipboard", event.target.checked)}
              />
              <span>{t("settings.keepClipboard")}</span>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.removeFillers}
                onChange={(event) => updateSetting("removeFillers", event.target.checked)}
              />
              <span>{t("settings.removeFillers")}</span>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.lowercase}
                onChange={(event) => updateSetting("lowercase", event.target.checked)}
              />
              <span>{t("settings.lowercase")}</span>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.removePunctuation}
                onChange={(event) => updateSetting("removePunctuation", event.target.checked)}
              />
              <span>{t("settings.removePunctuation")}</span>
            </label>

            <h2>{t("settings.general")}</h2>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.launchAtLogin}
                onChange={(event) => void updateLaunchAtLogin(event.target.checked)}
              />
              <span>{t("settings.launchAtLogin")}</span>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.soundEffects}
                onChange={(event) => updateSetting("soundEffects", event.target.checked)}
              />
              <span>{t("settings.sounds")}</span>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.saveHistory}
                onChange={(event) => updateSetting("saveHistory", event.target.checked)}
              />
              <span>{t("settings.saveHistory")}</span>
            </label>
            {settings.saveHistory && (
              <label className="stack">
                {t("settings.historyLimit")}
                <select
                  className="field"
                  value={settings.maxHistory}
                  onChange={(event) => updateSetting("maxHistory", Number(event.target.value))}
                >
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="200">200</option>
                  <option value="500">500</option>
                  <option value="0">{t("common.all")}</option>
                </select>
              </label>
            )}
          </>
        )}

        {page === "about" && (
          <>
            <p>{t("about.intro")}</p>
            <p>{t("about.privacy")}</p>
            <p>{t("about.tray")}</p>
            <p>
              {t("about.version", { version: packageInfo.version })}{" "}
              <a
                href="https://github.com/neriousy/aevum"
                target="_blank"
                rel="noreferrer"
                onClick={openLink("https://github.com/neriousy/aevum")}
              >
                {t("about.source")}
              </a>
            </p>
            <p className="muted">
              {t("about.creditsBefore")}{" "}
              <a
                href="https://github.com/cjpais/Handy"
                target="_blank"
                rel="noreferrer"
                onClick={openLink("https://github.com/cjpais/Handy")}
              >
                Handy
              </a>{" "}
              {t("about.creditsAnd")}{" "}
              <a
                href="https://github.com/kitlangton/hex"
                target="_blank"
                rel="noreferrer"
                onClick={openLink("https://github.com/kitlangton/hex")}
              >
                Hex by Kit Langton
              </a>
              {t("about.creditsAfter")}
            </p>
            <h2>{t("updates.title")}</h2>
            <p className="muted">{t("updates.info")}</p>
            {updatePhase === "current" && (
              <p className="status status-ready">
                <span className="dot" />
                {t("updates.latest")}
              </p>
            )}
            {updatePhase === "available" && (
              <>
                <p>
                  <strong>{t("updates.available", { version: updateVersion })}</strong>
                </p>
                {updateNotes && <p className="update-notes">{updateNotes}</p>}
              </>
            )}
            {updatePhase === "downloading" && (
              <>
                <p className="muted">
                  {t("updates.downloading", {
                    version: updateVersion,
                    progress: updateProgress > 0 ? ` — ${Math.round(updateProgress)}%` : "…",
                  })}
                </p>
                <progress className="update-progress" max="100" value={updateProgress} />
              </>
            )}
            {updatePhase === "restarting" && <p className="muted">{t("updates.restarting")}</p>}
            {updatePhase === "error" && (
              <p className="error">{t("updates.failed", { message: updateError })}</p>
            )}
            {updatePhase === "available" ? (
              <button type="button" className="button primary" onClick={() => void installUpdate()}>
                {t("updates.install", { version: updateVersion })}
              </button>
            ) : (
              <button
                type="button"
                className="button"
                disabled={
                  updatePhase === "checking" ||
                  updatePhase === "downloading" ||
                  updatePhase === "restarting"
                }
                onClick={() => void checkForUpdates()}
              >
                {updatePhase === "checking" ? t("updates.checking") : t("updates.check")}
              </button>
            )}
          </>
        )}
      </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
