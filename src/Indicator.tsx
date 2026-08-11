import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";

interface IndicatorPayload {
  status: "recording" | "locked" | "transcribing" | "loading";
  level: number;
  message?: string;
}

const DEFAULT_STATE: IndicatorPayload = {
  status: "recording",
  level: 0.15,
};

export function Indicator() {
  const [state, setState] = useState(DEFAULT_STATE);

  useEffect(() => {
    document.body.classList.add("indicator-body");
    if (!("__TAURI_INTERNALS__" in window)) {
      return () => document.body.classList.remove("indicator-body");
    }
    const unlisten = listen<IndicatorPayload>("indicator-state", (event) => {
      setState(event.payload);
    });
    return () => {
      document.body.classList.remove("indicator-body");
      void unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, []);

  const bars = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) => {
        const center = 1 - Math.abs(index - 3) / 4;
        return 5 + Math.max(0.08, state.level) * center * 22;
      }),
    [state.level],
  );

  const label =
    state.message ??
    ({
      recording: "Listening",
      locked: "Hands-free",
      transcribing: "Transcribing",
      loading: "Loading model",
    }[state.status] as string);

  return (
    <main className={`indicator-shell indicator-${state.status}`}>
      <div className="indicator-dot" />
      <div className="indicator-wave" aria-hidden="true">
        {bars.map((height, index) => (
          <span key={index} style={{ height }} />
        ))}
      </div>
      <span className="indicator-label">{label}</span>
      {(state.status === "transcribing" || state.status === "loading") && (
        <span className="indicator-spinner" />
      )}
    </main>
  );
}
