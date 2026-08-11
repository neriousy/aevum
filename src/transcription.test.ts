import { describe, expect, it, vi } from "vitest";
import { PARAKEET_MODEL, SENSEVOICE_MODEL } from "./settings";
import { TranscriptionEngine } from "./transcription";
import type { ModelId } from "./types";

interface PendingPreparation {
  model: ModelId;
  resolve: (result: { model: ModelId; requestId: number; activated: boolean }) => void;
  reject: (error: Error) => void;
}

function controlledPreparer() {
  const pending: PendingPreparation[] = [];
  const prepare = vi.fn(
    (model: ModelId) =>
      new Promise<{ model: ModelId; requestId: number; activated: boolean }>(
        (resolve, reject) => pending.push({ model, resolve, reject }),
      ),
  );
  return { pending, prepare };
}

describe("TranscriptionEngine model switching", () => {
  it("deduplicates repeated requests for the same desired model", async () => {
    const native = controlledPreparer();
    const engine = new TranscriptionEngine(native.prepare);

    const first = engine.prepare(PARAKEET_MODEL.id);
    const duplicate = engine.prepare(PARAKEET_MODEL.id);

    expect(native.prepare).toHaveBeenCalledTimes(1);
    native.pending[0].resolve({
      model: PARAKEET_MODEL.id,
      requestId: 1,
      activated: true,
    });
    await Promise.all([first, duplicate]);
    expect(engine.isReady(PARAKEET_MODEL.id)).toBe(true);
  });

  it("keeps only the latest A to B to A to B selection", async () => {
    const native = controlledPreparer();
    const engine = new TranscriptionEngine(native.prepare);
    const ready: ModelId[] = [];
    engine.onReady = (model) => ready.push(model);

    const initial = engine.prepare(PARAKEET_MODEL.id);
    native.pending[0].resolve({
      model: PARAKEET_MODEL.id,
      requestId: 1,
      activated: true,
    });
    await initial;
    ready.length = 0;

    const firstSenseVoice = engine.prepare(SENSEVOICE_MODEL.id);
    const backToParakeet = engine.prepare(PARAKEET_MODEL.id);
    const latestSenseVoice = engine.prepare(SENSEVOICE_MODEL.id);
    expect(native.prepare).toHaveBeenCalledTimes(4);

    native.pending[2].resolve({
      model: PARAKEET_MODEL.id,
      requestId: 3,
      activated: true,
    });
    native.pending[1].resolve({
      model: SENSEVOICE_MODEL.id,
      requestId: 2,
      activated: true,
    });
    native.pending[3].resolve({
      model: SENSEVOICE_MODEL.id,
      requestId: 4,
      activated: true,
    });

    await Promise.all([firstSenseVoice, backToParakeet, latestSenseVoice]);
    expect(ready).toEqual([SENSEVOICE_MODEL.id]);
    expect(engine.isReady(SENSEVOICE_MODEL.id)).toBe(true);
    expect(engine.isReady(PARAKEET_MODEL.id)).toBe(false);
  });

  it("does not surface errors from a superseded request", async () => {
    const native = controlledPreparer();
    const engine = new TranscriptionEngine(native.prepare);

    const obsolete = engine.prepare(SENSEVOICE_MODEL.id);
    const latest = engine.prepare(PARAKEET_MODEL.id);
    native.pending[0].reject(new Error("obsolete load failed"));
    native.pending[1].resolve({
      model: PARAKEET_MODEL.id,
      requestId: 2,
      activated: true,
    });

    await expect(obsolete).resolves.toBeUndefined();
    await expect(latest).resolves.toBeUndefined();
    expect(engine.isReady(PARAKEET_MODEL.id)).toBe(true);
  });
});
