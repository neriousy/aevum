import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  register,
  unregister,
  unregisterAll,
  type ShortcutEvent,
} from "@tauri-apps/plugin-global-shortcut";
import { disable, enable } from "@tauri-apps/plugin-autostart";
import { AudioCapture, playCue } from "./audio";
import { formatDuration, formatTranscript, relativeTime } from "./format";
import {
  getPreparedModel,
  HOTKEYS,
  LANGUAGES,
  loadHistory,
  loadSettings,
  MODELS,
  PASTE_HOTKEYS,
  saveHistory,
  saveSettings,
  setPreparedModel,
} from "./settings";
import { TranscriptionEngine } from "./transcription";
import type { HexSettings, Page, RecordingStatus, Transcript, WorkerProgress } from "./types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

async function invokeIfDesktop<T>(command: string, args?: Record<string, unknown>) {
  if (!isTauri()) return undefined;
  return invoke<T>(command, args);
}

const PAGES: Array<[Page, string]> = [
  ["home", "Home"],
  ["history", "History"],
  ["settings", "Settings"],
  ["about", "About"],
];

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
      {value.split("+").map((part, index) => (
        <span key={`${part}-${index}`}>
          {index > 0 && <span className="plus">+</span>}
          <kbd>{part}</kbd>
        </span>
      ))}
    </span>
  );
}

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [settings, setSettings] = useState<HexSettings>(loadSettings);
  const [history, setHistory] = useState<Transcript[]>(loadHistory);
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [meter, setMeter] = useState(0);
  const [modelProgress, setModelProgress] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [modelDetail, setModelDetail] = useState("");
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [search, setSearch] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");

  const audio = useRef(new AudioCapture());
  const engine = useRef<TranscriptionEngine | null>(null);
  if (!engine.current) engine.current = new TranscriptionEngine();
  const recordingStartedAt = useRef(0);
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

  statusRef.current = status;
  settingsRef.current = settings;
  historyRef.current = history;

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveHistory(history), [history]);
  useEffect(() => setConfirmClear(false), [page]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2800);
  }, []);

  const updateIndicator = useCallback(
    (nextStatus: string, level = 0, message?: string) =>
      void invokeIfDesktop("set_indicator", { status: nextStatus, level, message }),
    [],
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
    setModelDetail("Preparing the model");
    progressFiles.current.clear();
    setModelProgress((value) => Math.max(2, value));
    try {
      await engine.current!.prepare(settingsRef.current.model);
    } catch (prepareError) {
      const message = prepareError instanceof Error ? prepareError.message : String(prepareError);
      setModelProgress(0);
      setModelDetail("");
      setError(`The model download failed: ${message}`);
    }
  }, []);

  useEffect(() => {
    const currentEngine = engine.current!;
    currentEngine.onProgress = (progress: WorkerProgress) => {
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
        progress.status === "done"
          ? "Getting the model ready for this PC"
          : fileName
            ? `Downloading ${fileName}`
            : "Preparing the model",
      );
    };
    currentEngine.onReady = (model) => {
      setPreparedModel(model);
      const isCurrent = model === settingsRef.current.model;
      setModelReady(isCurrent);
      setModelProgress(isCurrent ? 100 : 0);
      setModelDetail("");
    };

    if (getPreparedModel() === settings.model) void prepareModel();
  }, [prepareModel, settings.model]);

  useEffect(() => {
    setModelReady(engine.current!.isReady(settings.model));
    if (!engine.current!.isReady(settings.model)) {
      progressFiles.current.clear();
      setModelProgress(0);
      setModelDetail("");
    }
  }, [settings.model]);

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
    notify("Recording cancelled");
  }, [notify, stopEscapeShortcut, updateIndicator]);
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
        statusRef.current = nextStatus;
        setStatus(nextStatus);
        updateIndicator(nextStatus);

        try {
          const rawText = await engine.current!.transcribe(
            samples,
            settingsRef.current.model,
            settingsRef.current.language,
          );
          const text = formatTranscript(rawText, settingsRef.current);
          if (!text) throw new Error("No speech was detected. Try speaking a little closer to the microphone.");

          const transcript: Transcript = {
            id: crypto.randomUUID(),
            text,
            createdAt: new Date().toISOString(),
            duration,
          };
          if (settingsRef.current.saveHistory) {
            setHistory((current) => {
              const next = [transcript, ...current];
              return settingsRef.current.maxHistory > 0
                ? next.slice(0, settingsRef.current.maxHistory)
                : next;
            });
          }

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
    [notify, stopEscapeShortcut, updateIndicator],
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
          updateIndicator(statusRef.current === "locked" ? "locked" : "recording", level);
        });
        recordingStartedAt.current = performance.now();
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
        setError(`Microphone unavailable: ${message}`);
        statusRef.current = "idle";
        setStatus("idle");
        void invokeIfDesktop("show_main");
      } finally {
        startingRef.current = false;
      }
    },
    [finishRecording, updateIndicator],
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
    let disposed = false;
    const install = async () => {
      await unregisterAll();
      if (disposed) return;
      await register(settings.hotkey, (event: ShortcutEvent) => {
        if (event.state === "Pressed") hotkeyPressRef.current();
        if (event.state === "Released") hotkeyReleaseRef.current();
      });
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
      setError(`Could not register ${settings.hotkey}: ${String(shortcutError)}`);
    });
    return () => {
      disposed = true;
      void unregisterAll();
    };
  }, [settings.hotkey, settings.pasteLastHotkey]);

  const requestMicrophone = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      await refreshMicrophones();
      notify("Microphone is ready");
    } catch (permissionError) {
      setError(`Microphone permission was not granted: ${String(permissionError)}`);
    }
  }, [notify, refreshMicrophones]);

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
        setError(`Could not update startup behavior: ${String(autostartError)}`);
      }
    },
    [updateSetting],
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
    notify("Copied to clipboard");
  };

  const currentModel = MODELS.find((model) => model.id === settings.model)!;
  const filteredHistory = history.filter((item) =>
    item.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const todayCount = history.filter(
    (item) => new Date(item.createdAt).toDateString() === new Date().toDateString(),
  ).length;
  const totalMinutes = history.reduce((total, item) => total + item.duration, 0) / 60;
  const recording = status === "recording" || status === "locked";
  const preparing = !modelReady && modelProgress > 0;

  const statusText = recording
    ? status === "locked"
      ? `Listening hands-free. Press ${settings.hotkey} to finish.`
      : "Listening. Release the shortcut to insert your words."
    : status === "transcribing"
      ? "Transcribing…"
      : status === "loading"
        ? "Loading the model…"
        : modelReady
          ? "Ready to transcribe."
          : "";

  const statusClass = recording
    ? "status-live"
    : status === "transcribing" || status === "loading"
      ? "status-busy"
      : "status-ready";

  const progressLine = `${modelDetail || "Preparing the model"} — ${Math.round(modelProgress)}%`;

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
              aria-label="Minimize"
              onClick={() => void getCurrentWindow().minimize()}
            >
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0 5h10" stroke="currentColor" strokeWidth="1.1" fill="none" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="Maximize"
              onClick={() => void getCurrentWindow().toggleMaximize()}
            >
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1.1" fill="none" />
              </svg>
            </button>
            <button
              type="button"
              className="titlebar-close"
              aria-label="Close"
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
          <p className="tagline">Voice typing that runs entirely on your PC.</p>
          <nav>
            {PAGES.map(([id, label]) => (
              <button
                type="button"
                key={id}
                className={page === id ? "active" : ""}
                onClick={() => setPage(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </header>

        {error && (
          <p className="error">
            {error}{" "}
            <button type="button" className="link" onClick={() => setError("")}>
              Dismiss
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
              Hold <Shortcut value={settings.hotkey} /> in any app and start talking. When you
              release, Aevum types what you said wherever your cursor is — emails, documents, chats,
              code. Press <kbd>Esc</kbd> while recording to cancel, or double-tap the shortcut to
              keep recording hands-free.
            </p>
            {!modelReady &&
              (preparing ? (
                <p className="muted">{progressLine}</p>
              ) : (
                <>
                  <p>
                    Before the first transcription, Aevum downloads the {currentModel.name} model
                    ({currentModel.size}) once and keeps it on this PC. Transcription runs
                    completely offline — no audio ever leaves your machine.
                  </p>
                  <button type="button" className="button primary" onClick={() => void prepareModel()}>
                    Download the {currentModel.name} model
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
                ? "Listening — release to finish"
                : status === "transcribing" || status === "loading"
                  ? "Transcribing…"
                  : "Hold to try it here"}
            </button>
            {history.length > 0 && (
              <>
                <p className="muted">
                  {todayCount === 0
                    ? "No transcriptions yet today"
                    : todayCount === 1
                      ? "One transcription today"
                      : `${todayCount} transcriptions today`}
                  {" · "}
                  {totalMinutes < 1
                    ? "less than a minute of speech captured in total."
                    : `${totalMinutes.toFixed(1)} minutes of speech captured in total.`}
                </p>
                <h2>Recent</h2>
                {history.slice(0, 3).map((item) => (
                  <div className="entry" key={item.id}>
                    <p className="entry-text">{item.text}</p>
                    <p className="meta">
                      {relativeTime(item.createdAt)} · {formatDuration(item.duration)} ·{" "}
                      <button type="button" className="link" onClick={() => void copyTranscript(item.text)}>
                        Copy
                      </button>
                    </p>
                  </div>
                ))}
                <button type="button" className="link" onClick={() => setPage("history")}>
                  See all history
                </button>
              </>
            )}
          </>
        )}

        {page === "history" && (
          <>
            {history.length === 0 ? (
              <p className="muted">
                Nothing here yet. Transcripts appear here after your first dictation, saved only on
                this PC.
              </p>
            ) : (
              <>
                <p className="muted">
                  {history.length === 1 ? "One transcript" : `${history.length} transcripts`}, stored
                  only on this PC.
                </p>
                <input
                  className="field"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search transcripts"
                  aria-label="Search transcripts"
                />
                {filteredHistory.length === 0 ? (
                  <p className="muted">No transcripts match your search.</p>
                ) : (
                  filteredHistory.map((item) => (
                    <div className="entry" key={item.id}>
                      <p className="entry-text">{item.text}</p>
                      <p className="meta">
                        {relativeTime(item.createdAt)} · {formatDuration(item.duration)} ·{" "}
                        <button type="button" className="link" onClick={() => void copyTranscript(item.text)}>
                          Copy
                        </button>{" "}
                        ·{" "}
                        <button
                          type="button"
                          className="link"
                          onClick={() =>
                            setHistory((current) => current.filter((entry) => entry.id !== item.id))
                          }
                        >
                          Delete
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
                  {confirmClear ? "Click again to delete everything" : "Clear history"}
                </button>
              </>
            )}
          </>
        )}

        {page === "settings" && (
          <>
            <h2>Model</h2>
            <p className="muted">
              Models are downloaded once, cached on this PC, and run completely offline.
            </p>
            {MODELS.map((model) => (
              <label className="choice" key={model.id}>
                <input
                  type="radio"
                  name="model"
                  checked={settings.model === model.id}
                  onChange={() => updateSetting("model", model.id)}
                />
                <span>
                  <strong>{model.name}</strong> — {model.size}. {model.description}
                </span>
              </label>
            ))}
            {!modelReady &&
              (preparing ? (
                <p className="muted">{progressLine}</p>
              ) : (
                <button type="button" className="button primary" onClick={() => void prepareModel()}>
                  Download the {currentModel.name} model
                </button>
              ))}

            <h2>Language</h2>
            <select
              className="field"
              aria-label="Spoken language"
              value={settings.language}
              onChange={(event) => updateSetting("language", event.target.value)}
            >
              {LANGUAGES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <h2>Microphone</h2>
            <select
              className="field"
              aria-label="Microphone"
              value={settings.microphoneId}
              onChange={(event) => updateSetting("microphoneId", event.target.value)}
            >
              <option value="default">System default</option>
              {microphones
                .filter((device) => device.deviceId !== "default")
                .map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))}
            </select>
            {microphones.every((device) => !device.label) && (
              <p className="muted">
                <button type="button" className="link" onClick={() => void requestMicrophone()}>
                  Allow microphone access
                </button>{" "}
                to see your devices by name.
              </p>
            )}

            <h2>Shortcuts</h2>
            <p className="muted">
              The record shortcut works globally, even while Aevum sits hidden in the tray.
            </p>
            <label className="stack">
              Start and stop recording
              <select
                className="field"
                value={settings.hotkey}
                onChange={(event) => updateSetting("hotkey", event.target.value)}
              >
                {HOTKEYS.map((hotkey) => (
                  <option key={hotkey}>{hotkey}</option>
                ))}
              </select>
            </label>
            <label className="stack">
              Paste the last transcript
              <select
                className="field"
                value={settings.pasteLastHotkey}
                onChange={(event) => updateSetting("pasteLastHotkey", event.target.value)}
              >
                {PASTE_HOTKEYS.map((hotkey) => (
                  <option key={hotkey} value={hotkey}>
                    {hotkey === "Disabled" ? "Off" : hotkey}
                  </option>
                ))}
              </select>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.doubleTapLock}
                onChange={(event) => updateSetting("doubleTapLock", event.target.checked)}
              />
              <span>Double-tap the shortcut to keep recording until you press it again</span>
            </label>
            <label className="stack">
              Ignore taps shorter than {settings.minimumKeyTime.toFixed(1)} seconds
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

            <h2>Output</h2>
            <p className="muted">How the transcribed text reaches your apps, and how it is cleaned up.</p>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.pasteWithClipboard}
                onChange={(event) => updateSetting("pasteWithClipboard", event.target.checked)}
              />
              <span>Insert text through the clipboard, which works in most apps</span>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.copyToClipboard}
                onChange={(event) => updateSetting("copyToClipboard", event.target.checked)}
              />
              <span>Keep each transcript on the clipboard so you can paste it again</span>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.removeFillers}
                onChange={(event) => updateSetting("removeFillers", event.target.checked)}
              />
              <span>Remove filler words like “um” and “uh”</span>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.lowercase}
                onChange={(event) => updateSetting("lowercase", event.target.checked)}
              />
              <span>Make everything lowercase</span>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.removePunctuation}
                onChange={(event) => updateSetting("removePunctuation", event.target.checked)}
              />
              <span>Remove punctuation, which is handy for terminals and search boxes</span>
            </label>

            <h2>General</h2>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.launchAtLogin}
                onChange={(event) => void updateLaunchAtLogin(event.target.checked)}
              />
              <span>Start Aevum when you sign in to Windows</span>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.soundEffects}
                onChange={(event) => updateSetting("soundEffects", event.target.checked)}
              />
              <span>Play a sound when recording starts and stops</span>
            </label>
            <label className="choice">
              <input
                type="checkbox"
                checked={settings.saveHistory}
                onChange={(event) => updateSetting("saveHistory", event.target.checked)}
              />
              <span>Save transcripts to history on this PC</span>
            </label>
            {settings.saveHistory && (
              <label className="stack">
                Number of transcripts to keep
                <select
                  className="field"
                  value={settings.maxHistory}
                  onChange={(event) => updateSetting("maxHistory", Number(event.target.value))}
                >
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="200">200</option>
                  <option value="500">500</option>
                  <option value="0">All of them</option>
                </select>
              </label>
            )}
          </>
        )}

        {page === "about" && (
          <>
            <p>
              Aevum turns speech into text anywhere on Windows. Hold the shortcut, talk, release,
              and the words appear wherever your cursor is — no window switching, no copy-pasting.
            </p>
            <p>
              Transcription runs entirely on this PC with OpenAI Whisper models. Recordings stay in
              memory only while they are being transcribed, transcripts are stored only in Aevum,
              and nothing is ever uploaded anywhere.
            </p>
            <p>
              Aevum lives in your system tray, so closing the window keeps it listening for the
              shortcut. Use the tray icon to reopen it or quit completely.
            </p>
            <p>
              Version 0.1.0. An independent Windows adaptation of{" "}
              <a href="https://github.com/kitlangton/Hex" target="_blank" rel="noreferrer">
                Hex by Kit Langton
              </a>
              , built with Tauri and Transformers.js. MIT licensed.
            </p>
          </>
        )}
      </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
