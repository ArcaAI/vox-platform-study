/**
 * External-microphone / injected-stream browser harness.
 *
 * WHY A SECOND HARNESS (and not `index.html`)
 * -------------------------------------------
 * `index.html` loads the pre-built `dist/e2e-bundle.mjs`, which is emitted with
 * `react`, `valibot`, `diff`, `@arcaai/stt`, … left EXTERNAL. Those bare
 * specifiers are unresolvable in a plain browser (no import map on that page),
 * so the SDK module never evaluates there. This harness is bundled separately
 * with NOTHING external, so it loads standalone (see the `beforeAll` builder in
 * `task612-external-streams.e2e.spec.ts`).
 *
 * WHAT IS REAL AND WHAT IS A DOUBLE
 * ---------------------------------
 * Real: the browser's WebAudio graph (`AudioContext`, `OscillatorNode`,
 * `ConstantSourceNode`, `MediaStreamAudioDestinationNode`), real
 * `MediaStream`/`MediaStreamTrack` objects with real `readyState`, the real
 * `@arcaai/room` `AudioContextManager` + `AudioMixer`, the real Zustand store,
 * and the real `useArcaAudio` hook under test. That is the entire point of this
 * lane: the unit suites only ever saw doubles, so nothing until now proved the
 * Contracts against a real audio graph.
 *
 * Doubled: the `PluginManager` only. It stands in for the STT/VAD/noise-filter
 * stack, which needs ONNX/WASM models and a live gateway — neither of which
 * this suite has, and neither of which any contract depends on. Its
 * shape mirrors the double the unit suites use
 * (`src/hooks/__tests__/task612-*.test.ts`).
 *
 * The page exposes `window.__T612` — every value that crosses the Playwright
 * boundary is a string/number/boolean, because `MediaStream`s cannot be
 * serialized; streams live in a page-side registry addressed by id.
 */

import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AgenticStoreContext, createAgenticStore } from '../../src/store';
import { useArcaAudio } from '../../src/hooks/useArcaAudio';

// ---------------------------------------------------------------------------
// Log capture — `useArcaAudio` reads its logger from `store.logger` via
// `logger?.child('useArcaAudio')`, so a duck-typed logger is enough to observe
// the RC-2 "capture-shaped options were DROPPED" warn and the Lane D
// silent-uplink warn from the spec.
// ---------------------------------------------------------------------------
type LogEntry = { level: string; message: string };
const logEntries: LogEntry[] = [];

function makeLogger(): Record<string, unknown> {
  const record = (level: string) => (message: string) => {
    logEntries.push({ level, message: String(message) });
  };
  const logger: Record<string, unknown> = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    // `OperationTimer` (core/logger/types.ts) — `end` AND `error`; a partial
    // double here would surface as a TypeError that MASKS the real start error.
    startOperation: () => ({ end: () => undefined, error: () => undefined }),
  };
  logger.child = () => logger;
  return logger;
}

// ---------------------------------------------------------------------------
// PluginManager double (the ONLY double in this harness).
// ---------------------------------------------------------------------------
function makePluginManager() {
  const states = {
    noiseFilter: { isActive: false, isSupported: true },
    vad: { isActive: false, isSupported: true },
    stt: { isActive: true, isSupported: true, isProcessing: false },
  };
  const manager = {
    initialized: false,
    initializeCalls: 0,
    lastTrackLabel: null as string | null,
    setRuntimeOptions: () => undefined,
    clearRuntimeOptions: () => undefined,
    setCallbacks: () => undefined,
    async initialize(track: MediaStreamTrack | undefined) {
      manager.initializeCalls += 1;
      manager.lastTrackLabel = track ? track.label || '(unlabelled)' : null;
      manager.initialized = true;
    },
    async destroy() {
      manager.initialized = false;
    },
    getStates: () => states,
    async setEnabled() {
      return undefined;
    },
    getTranscriptionPipeline: () => null,
    getKnowledgePipeline: () => null,
  };
  return manager;
}

// ---------------------------------------------------------------------------
// Synthetic external microphones.
//
// A `MediaStreamAudioDestinationNode` yields a REAL `MediaStream` with a real
// live `MediaStreamTrack` — the same construction an integrator uses for a
// file-backed or virtual source (`apps/compat-playground/src/lib/file-audio-source.ts`),
// with an oscillator (signal) or a constant 0 (the RC-4 live-but-silent case)
// standing in for the file.
// ---------------------------------------------------------------------------
type SourceEntry = { stream: MediaStream; kind: 'tone' | 'silent' | 'dead' };
const sources = new Map<string, SourceEntry>();
let sourceSeq = 0;
let sourceCtx: AudioContext | null = null;

/** Created/resumed from a real click so no autoplay policy can leave it suspended. */
function armSourceContext(): AudioContext {
  if (!sourceCtx || sourceCtx.state === 'closed') {
    sourceCtx = new AudioContext({ sampleRate: 48000 });
  }
  if (sourceCtx.state === 'suspended') void sourceCtx.resume();
  return sourceCtx;
}

function register(stream: MediaStream, kind: SourceEntry['kind']): string {
  sourceSeq += 1;
  const id = `src-${sourceSeq}`;
  sources.set(id, { stream, kind });
  return id;
}

function makeTone(frequency = 440): string {
  const ctx = armSourceContext();
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.5;
  osc.frequency.value = frequency;
  osc.connect(gain);
  gain.connect(dest);
  osc.start();
  return register(dest.stream, 'tone');
}

function makeSilent(): string {
  const ctx = armSourceContext();
  const dest = ctx.createMediaStreamDestination();
  // A live source node emitting a constant 0 — structurally valid audio whose
  // every sample is zero. This is RC-4: the socket carries frames, the frames
  // carry silence, and nothing before Lane D said so.
  const constant = ctx.createConstantSource();
  constant.offset.value = 0;
  constant.connect(dest);
  constant.start();
  return register(dest.stream, 'silent');
}

function makeDead(): string {
  const id = makeTone();
  const entry = sources.get(id)!;
  entry.kind = 'dead';
  entry.stream.getTracks().forEach((t) => t.stop());
  return id;
}

function resolveStreams(ids: string[] | undefined): MediaStream[] {
  return (ids ?? []).map((id) => {
    const entry = sources.get(id);
    if (!entry) throw new Error(`unknown source id: ${id}`);
    return entry.stream;
  });
}

// ---------------------------------------------------------------------------
// React harness
// ---------------------------------------------------------------------------
const storeApi = createAgenticStore();
const pluginManager = makePluginManager();
storeApi.setState({
  // Cast at the seam: the harness deliberately runs the real hook against a
  // stand-in manager (see the header note).
  pluginManager: pluginManager as unknown as never,
  logger: makeLogger() as unknown as never,
  consultation: { id: 'e2e-task612' } as unknown as never,
});

type AudioApi = ReturnType<typeof useArcaAudio>;
let audioApi: AudioApi | null = null;

function Harness(): React.ReactElement {
  const audio = useArcaAudio();
  useEffect(() => {
    audioApi = audio;
    (window as unknown as { __T612_READY?: boolean }).__T612_READY = true;
  });
  return React.createElement('div', { id: 'harness-mounted' }, 'harness mounted');
}

type CallResult = { ok: true } | { ok: false; name: string; code: string | null; message: string };

function toResult(error: unknown): CallResult {
  const err = error as { name?: string; code?: string; message?: string };
  return {
    ok: false,
    name: String(err?.name ?? 'Error'),
    code: typeof err?.code === 'string' ? err.code : null,
    message: String(err?.message ?? error),
  };
}

const api = {
  makeTone,
  makeSilent,
  makeDead,
  armed: () => sourceCtx?.state ?? 'none',

  trackStates(id: string): string[] {
    const entry = sources.get(id);
    if (!entry) throw new Error(`unknown source id: ${id}`);
    return entry.stream.getAudioTracks().map((t) => t.readyState);
  },

  trackCount(id: string): number {
    const entry = sources.get(id);
    if (!entry) throw new Error(`unknown source id: ${id}`);
    return entry.stream.getAudioTracks().length;
  },

  async start(options?: { streams?: string[]; pipelineId?: string; dynamicSources?: boolean; language?: string }): Promise<CallResult> {
    if (!audioApi) throw new Error('harness not mounted');
    const sourceStreams = options?.streams ? resolveStreams(options.streams) : undefined;
    try {
      await audioApi.start({
        ...(sourceStreams ? { sourceStreams } : {}),
        ...(options?.pipelineId ? { pipelineId: options.pipelineId } : {}),
        ...(options?.dynamicSources ? { dynamicSources: true } : {}),
        ...(options?.language ? { language: options.language } : {}),
      });
      return { ok: true };
    } catch (error) {
      return toResult(error);
    }
  },

  async stop(): Promise<CallResult> {
    if (!audioApi) throw new Error('harness not mounted');
    try {
      await audioApi.stop();
      return { ok: true };
    } catch (error) {
      return toResult(error);
    }
  },

  snapshot() {
    const s = storeApi.getState();
    return {
      isCapturing: s.isCapturing,
      audioLevel: s.audioLevel,
      sourceLevels: [...(s.audioSourceLevels ?? [])],
      sourceIds: [...(s.audioSourceIds ?? [])],
      audioSignalState: s.audioSignalState,
      audioError: s.audioError ? String(s.audioError.message) : null,
      hasActiveStream: Boolean(s.activeStream),
      initializeCalls: pluginManager.initializeCalls,
      pluginInitialized: pluginManager.initialized,
    };
  },

  logs: (level?: string): string[] => logEntries.filter((e) => !level || e.level === level).map((e) => e.message),

  clearLogs: () => {
    logEntries.length = 0;
  },
};

(window as unknown as { __T612: typeof api }).__T612 = api;

const container = document.getElementById('harness-root');
if (container) {
  // The store context — NOT `AgenticProvider` — is what the hooks require, and
  // it is all this harness wants: `AgenticProvider` would also build a real
  // `AgenticClient`/`PluginManager` and talk to a gateway that is not running.
  createRoot(container).render(React.createElement(AgenticStoreContext.Provider, { value: storeApi }, React.createElement(Harness)));
}

// The arm button gives the source AudioContext a real user gesture — a
// suspended source context would emit silence and make every tone scenario a
// false negative.
document.getElementById('t612-arm')?.addEventListener('click', () => {
  armSourceContext();
  const el = document.getElementById('t612-arm-state');
  if (el) el.textContent = sourceCtx?.state ?? 'none';
});
