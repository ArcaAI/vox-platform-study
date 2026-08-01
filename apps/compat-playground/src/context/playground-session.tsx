import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
// `useArcaSttLanguageModes` is a v2-native hook (TASK-587) with no v1 ancestor.
// It MUST be imported from `@arcaai/vox/compat` — the SAME entry bundle as
// `<ArcaCompatProvider>` — because the store React context does not cross
// entry-point bundles (tsup `splitting: false`). Importing it from
// `@arcaai/vox/core` makes `useStoreApi()` read a different context instance
// and throw "must be used within an <AgenticProvider>".
import { useArcaSessionManager, useAudioCapture, useArcaSpeechToText, useArcaSttLanguageModes } from '@arcaai/vox/compat';
import { type SttLanguageModeOption } from '@arcaai/ui';
import { toast } from 'sonner';
import { type TranscriptLine } from '../components/TranscriptColumn';
import { saveStoredConfig, type PlaygroundConfig } from '../lib/config-store';
import { useAudioSources } from '../hooks/use-audio-sources';

// =============================================================================
// Why this file exists
// =============================================================================
//
// The console is split into three ISOLATED tabs (Connection / Live
// transcription / Summarization). A capture session, however, is a single
// long-lived thing: the mic, the WebSocket, and the accumulating transcript
// must survive every tab switch, and the Summarization tab must be able to read
// the transcript the Live-transcription tab produced.
//
// Two rules make that work, and both are load-bearing:
//
//  1. This provider is mounted ONCE, INSIDE `<ArcaCompatProvider>` and OUTSIDE
//     `<Tabs>` (see `App.tsx`). Anything session-shaped that lived in a tab
//     component would be torn down the moment that tab stopped rendering.
//  2. Every `<TabsContent>` panel is `forceMount`ed and hidden with CSS
//     (`data-[state=inactive]:hidden`) rather than unmounted. Radix unmounts
//     inactive panels by default, which would kill a live session.
//
// =============================================================================
// Context shape — grouped by concern, on purpose
// =============================================================================
//
// The value is deliberately a set of NAMED GROUPS rather than one flat bag, so
// that parallel work adds fields to the right group instead of colliding in a
// single 25-field interface. Current ownership:
//
// | Group        | Owner  | What gets added next                                |
// |--------------|--------|-----------------------------------------------------|
// | `session`    | Lane 0 | —                                                    |
// | `capture`    | Lane B | DONE — `phase` + capture-first `stop()`               |
// | `transcript` | Lane D | reference transcript + WER/CER scores                |
// | `language`   | Lane 0 | —                                                    |
// | `metadata`   | Lane C | per-mic metadata rows, auto-tagging                  |
// | `audio`      | Lane A | NEW group — device ids, file-backed streams, mode    |
// | `pipeline`   | Lane E | NEW group — selected pipeline id + provider toggle   |
//
// Adding a NEW concern means adding a new top-level group (and its exported
// `Playground*Slice` interface) — not widening an existing one.

/** Session identity + lifecycle, from `useArcaSessionManager`. Owned by lane 0. */
export interface PlaygroundSessionSlice {
  /** v2 consultation id once one exists, else `undefined`. */
  id: string | undefined;
  /** v1-shaped status string (`IDLE`/`ACTIVE`/`TERMINATED`), or `'none'`. */
  status: string;
  /** Session-manager error message, if any. */
  error: string | null;
  /** The session is still loading and nothing has streamed — render skeletons. */
  isPreSession: boolean;
}

/**
 * Where the capture session is in its lifecycle (TASK-597 lane B).
 *
 * `stopping` is the state that did not exist before: from 597 the mic is
 * released the instant Stop is clicked, but the STT transport keeps draining
 * behind it so tail finals still land. That window is a REAL state — the mic is
 * already off, the session is not idle yet — and hiding it behind `isRecording`
 * is what made Stop look either frozen or prematurely finished.
 */
export type PlaygroundCapturePhase = 'idle' | 'starting' | 'recording' | 'stopping';

/**
 * Mic/transport lifecycle.
 *
 * **Lane B (TASK-597 D2/D3)** added `phase` and reordered `stop()` so the
 * capture graph is released before the drain is awaited. `isRecording` and
 * `isStarting` are kept as-is — several consumers read them — and are now
 * simply projections of `phase`.
 */
export interface PlaygroundCaptureSlice {
  /** Mic live. Goes false the moment Stop is clicked, NOT when the drain ends. */
  isRecording: boolean;
  /** Between the Start click and the mic actually being live. */
  isStarting: boolean;
  /**
   * The full lifecycle. `stopping` means "mic off, transport still finalizing" —
   * tail finals are still appending to `transcript.lines` while it shows, and
   * Start must stay disabled until it clears.
   */
  phase: PlaygroundCapturePhase;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Everything the transcript produces. **Lane D** extends this with the
 * reference transcript and the WER/CER scorecard; **lane F** reads `lineTexts`.
 */
export interface PlaygroundTranscriptSlice {
  /** Final lines, in arrival order, with the metadata that round-tripped. */
  lines: TranscriptLine[];
  /** Text-only projection of `lines` — the summarization input. */
  lineTexts: string[];
  /** The in-flight (non-final) hypothesis, or `''`. */
  interim: string;
  /** STT error message, if any. */
  error: string | null;
  /** Drop every line + the interim (does not touch the session). */
  clear: () => void;
}

/** STT language-mode catalog + selection (TASK-587). Owned by lane 0. */
export interface PlaygroundLanguageSlice {
  /** Backend catalog when available, static fallback otherwise. */
  modes: SttLanguageModeOption[];
  mode: string;
  setMode: (modeId: string) => void;
  /** Catalog fetch error — the fallback list is showing when this is set. */
  catalogError: string | null;
}

/**
 * `MAX_METADATA_BYTES` mirrors the frozen guard in
 * `packages/agentic-sdk-v2/src/compat/speechToTextMetadata.ts` (TASK-564/565).
 * That constant is internal to the SDK package — not re-exported from the
 * public `@arcaai/vox/compat` barrel — so this is a deliberate, documented
 * duplicate of a value the hook itself already enforces (it throws past this
 * size); duplicating it here lets the UI catch the violation BEFORE the throw
 * and render it as an inline field error instead of a toast/exception.
 */
const MAX_METADATA_BYTES = 8192;

/** One `{mic, speaker}` row — the screenshot's per-source tagging shape (TASK-597 R5). */
export interface MetadataMicRow {
  id: string;
  mic: string;
  speaker: string;
  /** Free-form JSON object, merged alongside `mic`/`speaker`. */
  json: string;
}

type RowMetadataResult = { metadata: Record<string, unknown> } | { error: string };

/**
 * Build the `sendAudioData` payload for a row and validate it against the 8 KB
 * guard BEFORE sending (TASK-597 R5 requirement 4). Pure + exported so the
 * guard is unit-testable without mounting the provider.
 */
export function buildRowMetadata(row: MetadataMicRow): RowMetadataResult {
  let extra: Record<string, unknown> = {};
  if (row.json.trim()) {
    try {
      const parsed = JSON.parse(row.json) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { error: 'metadata JSON must be an object' };
      }
      extra = parsed as Record<string, unknown>;
    } catch (err) {
      return { error: `Invalid metadata JSON: ${err instanceof Error ? err.message : 'parse error'}` };
    }
  }
  const metadata: Record<string, unknown> = { ...extra };
  if (row.mic.trim()) metadata.mic = row.mic.trim();
  if (row.speaker.trim()) metadata.speaker = row.speaker.trim();
  const size = JSON.stringify(metadata).length;
  if (size > MAX_METADATA_BYTES) {
    return { error: `Metadata exceeds ${MAX_METADATA_BYTES} bytes (currently ${size}).` };
  }
  return { metadata };
}

const INITIAL_METADATA_ROWS: MetadataMicRow[] = [
  { id: 'mic-1', mic: '1', speaker: '1', json: '{}' },
  { id: 'mic-2', mic: '2', speaker: '2', json: '{}' },
];

/**
 * The metadata simulator (TASK-564 client-side passthrough). **Lane C** owns
 * this group from here on: per-mic rows, auto-tagging on level, and the 8 KB
 * `MAX_METADATA_BYTES` guard.
 *
 * `rows` starts as a MANUALLY-managed 2-slot list and stays fully
 * self-sufficient (add/remove/edit rows by hand) whether or not lane A's
 * `audio.sources` is populated. `syncRowsFromSources` is an opt-in bridge the
 * UI calls with `audio.sources` when that list is non-empty — this group
 * never reads `audio` itself, so it was never blocked on lane A landing.
 */
export interface PlaygroundMetadataSlice {
  speakerId: string;
  setSpeakerId: (v: string) => void;
  language: string;
  setLanguage: (v: string) => void;
  /** Free-form JSON object, merged under the two named fields above. */
  json: string;
  setJson: (v: string) => void;
  /** The last payload handed to `sendAudioData`, for the "Last sent" readout. */
  lastSent: Record<string, unknown> | null;
  send: () => void;
  /** Inline 8 KB field error for the manual form above — never a toast. */
  sendError: string | null;

  /** Per-mic metadata rows — one `{mic, speaker, ...json}` row per configured source. */
  rows: MetadataMicRow[];
  addRow: () => void;
  /** No-op below one row — the list, and auto-tag rotation, must never go empty. */
  removeRow: (id: string) => void;
  updateRow: (id: string, patch: Partial<Pick<MetadataMicRow, 'mic' | 'speaker' | 'json'>>) => void;
  sendRow: (id: string) => void;
  /** Inline 8 KB / JSON-parse field error per row id. */
  rowErrors: Record<string, string | null>;
  /**
   * Replace `rows` with one row per entry, in order, preserving each row's
   * free-form JSON where the count lines up. Called from the UI with lane A's
   * `audio.sources` when that group exists and is non-empty — this group
   * never reaches into `audio` itself, so it is never blocked on lane A.
   */
  syncRowsFromSources: (sources: Array<{ id: string; micLabel: string }>) => void;

  /**
   * Opt-in switch: while recording, alternate through `rows` and call
   * `sendAudioData` automatically whenever the input level crosses
   * `autoTagThreshold` — debounced (rising-edge + cooldown) to one emit per
   * utterance, not per animation frame.
   */
  autoTagEnabled: boolean;
  setAutoTagEnabled: (v: boolean) => void;
  /** 0–100, same scale as the SDK's input-level meter. */
  autoTagThreshold: number;
  setAutoTagThreshold: (v: number) => void;
}

/**
 * The four audio-source modes of the console. Every one of them ends up in the
 * SAME capture graph (mixer → noise filter → VAD → STT) — the file modes swap
 * `getUserMedia` for `decodeAudioData`, nothing else.
 */
export type PlaygroundAudioMode = 'single-mic' | 'multi-mic' | 'file-single' | 'file-multi';

/** One resolved capture source, in MIXER order. */
export interface PlaygroundAudioSource {
  /** Stable id: a `deviceId` in the mic modes, `file-N` in the file modes. */
  id: string;
  /** Ordinal label in mixer order — `mic 1`, `mic 2`, … Lane C tags metadata with it. */
  micLabel: string;
  /** What the source actually is: the device label, or the file name. */
  sourceLabel: string;
  /** Linear mixer gain; `1` is unity. */
  gain: number;
}

/** File-playback transport state, mirrored from the decoded source group. */
export interface PlaygroundAudioFilePlayback {
  isPlaying: boolean;
  /** Seconds into the longest track. */
  currentTime: number;
  /** Seconds of the longest track. */
  duration: number;
  loop: boolean;
  /** Playback rate multiplier; `1` is realtime. */
  rate: number;
}

/**
 * Audio-source selection (TASK-597 lane A) — which microphone(s), or which
 * audio file(s), the capture graph is fed from. Owned by lane A.
 *
 * Lane C reads `sources` (ordered, with `micLabel`) to attribute per-mic
 * metadata; nothing else in the console writes this group.
 */
export interface PlaygroundAudioSlice {
  mode: PlaygroundAudioMode;
  setMode: (mode: PlaygroundAudioMode) => void;

  /** `audioinput` devices. Labels stay BLANK until mic permission is granted. */
  devices: MediaDeviceInfo[];
  /** Inferred from label presence — the only signal the browser gives us. */
  permissionStatus: 'granted' | 'prompt';
  refreshDevices: () => Promise<void>;
  /** Opens and immediately releases a mic purely to make labels readable. */
  requestPermission: () => Promise<void>;
  /** Selected device ids — selection ORDER is mixer order. */
  selectedDeviceIds: string[];
  /** Single-mic mode: replace the selection. */
  selectDevice: (deviceId: string) => void;
  /** Multi-mic mode: add/remove, appending so order stays meaningful. */
  toggleDevice: (deviceId: string) => void;

  /** A file decode is in flight. */
  isDecoding: boolean;
  /** Decode/playback failure message, or `null`. */
  fileError: string | null;
  /** Split a stereo file into two virtual mics (L → mic 1, R → mic 2). */
  splitStereo: boolean;
  setSplitStereo: (v: boolean) => void;
  loadFiles: (files: File[]) => Promise<void>;
  clearFiles: () => void;
  playback: PlaygroundAudioFilePlayback;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  setLoop: (v: boolean) => void;
  setRate: (rate: number) => void;

  /** The resolved capture sources, in mixer order. */
  sources: PlaygroundAudioSource[];
  setGain: (sourceId: string, gain: number) => void;
  /** Exactly what is spread into `useAudioCapture(...)` on the next start. */
  captureOptions: {
    deviceId?: string;
    secondaryDeviceId?: string;
    additionalDeviceIds?: string[];
    sourceStreams?: MediaStream[];
    sourceGains?: number[];
  };
}

/**
 * The value published by `<PlaygroundSessionProvider>`.
 *
 * Read it with `usePlaygroundSession()`. Lane E adds a `pipeline` group
 * alongside these.
 */
export interface PlaygroundSessionContextValue {
  /** The connected config — the same object `<ArcaCompatProvider>` was built from. */
  config: PlaygroundConfig;
  session: PlaygroundSessionSlice;
  capture: PlaygroundCaptureSlice;
  transcript: PlaygroundTranscriptSlice;
  language: PlaygroundLanguageSlice;
  metadata: PlaygroundMetadataSlice;
  audio: PlaygroundAudioSlice;
}

const PlaygroundSessionContext = createContext<PlaygroundSessionContextValue | null>(null);

/** Static fallback when the TASK-587 catalog hook yields nothing (loading/empty/error). */
export const FALLBACK_LANGUAGE_MODES: SttLanguageModeOption[] = [
  { id: 'en', label: 'English', kind: 'single' },
  { id: 'ml', label: 'Malayalam', kind: 'single' },
  { id: 'ml-en', label: 'Malayalam + English', kind: 'code_switch' },
  { id: 'vi', label: 'Vietnamese', kind: 'single' },
  { id: 'vi-en', label: 'Vietnamese + English', kind: 'code_switch' },
  { id: 'auto', label: 'Auto-detect', kind: 'auto' },
];

function formatTimestamp(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const minutes = Math.floor(clamped / 60);
  const seconds = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

interface PlaygroundSessionProviderProps {
  config: PlaygroundConfig;
  children: ReactNode;
}

/**
 * Owns the live session for the whole console.
 *
 * Mount it INSIDE `<ArcaCompatProvider>` (the compat hooks below need that
 * store) and OUTSIDE `<Tabs>` (so no tab switch can unmount it). Written the
 * way a v1-migrating developer would: session via `useArcaSessionManager`, mic
 * via `useAudioCapture`, streaming transcript via `useArcaSpeechToText`'s
 * `onTranscript(text, isFinal, metadata)`.
 */
export function PlaygroundSessionProvider({ config, children }: PlaygroundSessionProviderProps) {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [interim, setInterim] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  // True from the Stop click until the STT transport has finished draining —
  // the mic is already off for all of it (TASK-597 lane B).
  const [isStopping, setIsStopping] = useState(false);
  const [languageMode, setLanguageMode] = useState(config.languageMode || 'en');

  // Capture-relative anchor for the fallback (arrival-time) timestamp used
  // when a final segment carries no numeric `meta.startTime`.
  const captureStartRef = useRef<number | null>(null);

  // TASK-587 — the backend-authoritative language-mode catalog.
  const languageModes = useArcaSttLanguageModes();
  const modes = languageModes.modes.length > 0 ? languageModes.modes : FALLBACK_LANGUAGE_MODES;

  // Metadata-simulation state (TASK-564 client-side passthrough demo).
  const [simSpeakerId, setSimSpeakerId] = useState('');
  const [simLanguage, setSimLanguage] = useState('');
  const [simMetadataJson, setSimMetadataJson] = useState('{}');
  const [lastSentMetadata, setLastSentMetadata] = useState<Record<string, unknown> | null>(null);
  /** Inline 8 KB field error for the manual form above — set BEFORE the throw, never a toast. */
  const [sendError, setSendError] = useState<string | null>(null);

  // Per-mic metadata rows (TASK-597 lane C, R5) + the auto-tag mode that
  // alternates through them on a detected input-level crossing.
  const [rows, setRows] = useState<MetadataMicRow[]>(INITIAL_METADATA_ROWS);
  const [rowErrors, setRowErrors] = useState<Record<string, string | null>>({});
  const [autoTagEnabled, setAutoTagEnabled] = useState(false);
  const [autoTagThreshold, setAutoTagThreshold] = useState(35);
  const rowIdCounterRef = useRef(INITIAL_METADATA_ROWS.length);
  // Long-lived interval callback needs the LATEST rows without re-subscribing
  // on every keystroke in a row's JSON field (rows changes on every edit).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Rising-edge latch: true while the level is above threshold, so a single
  // sustained utterance (many poll ticks above threshold) fires exactly once —
  // it re-arms only once the level drops back below.
  const autoTagAboveRef = useRef(false);
  const autoTagCursorRef = useRef(0);

  const mgr = useArcaSessionManager({
    doctorId: 'compat-playground-doctor',
    doctorName: 'Compat Playground',
    patientId: 'compat-playground-patient',
    patientName: 'Demo Patient',
  });
  // Audio-source selection (TASK-597 lane A). Mounted here, above the tabs, so
  // decoded file buffers and live streams survive a tab switch like the mic does.
  const audio = useAudioSources();
  // Forward the end-user language selection to the capture hook too: it starts
  // the mic BEFORE `stt.startTranscription()` and wins the shared-audio start
  // race, so the language must ride along here or the pick is dropped (TASK-587).
  // The source options ride the SAME hook for the same reason: whichever hook
  // calls `audio.start(...)` first wins, and that is this one (TASK-597).
  const capture = useAudioCapture({ language: languageMode, languageMode, ...audio.captureOptions });
  // "Keep it fresh" ref for the level-status reader (same pattern as
  // `onTranscriptRef` in `useArcaSpeechToText.ts`) — avoids putting
  // `capture.getDeviceStatus` (which changes identity whenever `audio.level`
  // ticks, ~10x/second while recording) in the auto-tag effect's dependency
  // array, which would tear the poll interval down and recreate it before it
  // ever gets a chance to fire.
  const getDeviceStatusRef = useRef(capture.getDeviceStatus);
  getDeviceStatusRef.current = capture.getDeviceStatus;
  const stt = useArcaSpeechToText({
    sessionId: mgr.session?.id ?? '',
    language: languageMode,
    // The stream-relative time already shows on the first line (the `mm:ss.mmm`
    // label), so drop `{timestamp}` from the templated transcript line to avoid
    // rendering the raw seconds twice. Speaker + text only (TASK-591).
    transcriptTemplate: '{speaker_id}: {text}',
    // End-user language mode (TASK-587) forwarded via the frozen v1 `options`
    // bag; takes precedence over `language` on the backend path.
    options: { pipelineId: config.pipelineId.trim() || undefined, languageMode },
    onTranscript: (text, isFinal, meta) => {
      if (isFinal) {
        const startTime = typeof meta?.startTime === 'number' ? meta.startTime : undefined;
        const arrivalSeconds = captureStartRef.current !== null ? (Date.now() - captureStartRef.current) / 1000 : 0;
        setLines((prev) => [...prev, { text, meta, timestamp: formatTimestamp(startTime ?? arrivalSeconds) }]);
        setInterim('');
      } else {
        setInterim(text);
      }
    },
    onError: (err) => toast.error(`STT error: ${err.message}`),
  });

  const isPreSession = mgr.isLoading && !mgr.session;

  const start = async () => {
    // `isStopping` too: the mic is already released during the drain, so
    // `capture.isRecording` alone would let a re-start race a teardown.
    if (isStarting || isStopping || capture.isRecording) return;
    setIsStarting(true);
    setLines([]);
    setInterim('');
    setLastSentMetadata(null);
    setSendError(null);
    setRowErrors({});
    autoTagAboveRef.current = false;
    captureStartRef.current = Date.now();
    try {
      // No consultation is opened: STT (recording + live transcription) does not
      // require a consultation session. We go straight to capture + streaming STT;
      // `consultationId` is simply absent on the stream.
      await capture.startRecording();
      await stt.startTranscription();
      toast.success('Recording live.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start recording');
    } finally {
      setIsStarting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Stop — capture FIRST, drain second (TASK-597 lane B, finding D2).
  //
  // The old order awaited `stopTranscription()` (which blocks on the WebSocket
  // drain) and only then released the mic, so the browser's recording indicator
  // stayed lit and the button stayed stuck for the whole drain window.
  //
  // Two things changed, and both are needed:
  //   • `useArcaAudio.stopAudio` now releases every track and flips
  //     `isCapturing` SYNCHRONOUSLY, then awaits the drain. So the mic is off
  //     before this function reaches its first `await`.
  //   • The two compat hooks share ONE audio graph, so both calls are made
  //     against the SAME teardown: issuing `stopTranscription()` while
  //     `stopRecording()` is still in flight hits the SDK's in-flight guard and
  //     joins that promise instead of starting a second drain. It still runs
  //     for its own sake — it resets the metadata timeline.
  //
  // The returned promise deliberately still spans the drain: `phase` stays
  // `stopping` until teardown is genuinely complete, so Start cannot be
  // re-armed on top of a half-closed session.
  // ---------------------------------------------------------------------------
  const stop = async () => {
    if (isStopping) return;
    setIsStopping(true);
    try {
      const draining = capture.stopRecording();
      await Promise.all([draining, stt.stopTranscription()]);
      toast.success('Recording stopped.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to stop recording');
    } finally {
      captureStartRef.current = null;
      setIsStopping(false);
    }
  };

  const handleLanguageModeChange = (modeId: string) => {
    setLanguageMode(modeId);
    // Persist across reloads — does not touch the `connected` state in App.tsx,
    // so it never remounts `<ArcaCompatProvider>`.
    saveStoredConfig({ ...config, languageMode: modeId });
  };

  const handleSendMetadata = () => {
    setSendError(null);
    let extra: Record<string, unknown> = {};
    if (simMetadataJson.trim()) {
      try {
        const parsed = JSON.parse(simMetadataJson) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('metadata JSON must be an object');
        }
        extra = parsed as Record<string, unknown>;
      } catch (err) {
        toast.error(`Invalid metadata JSON: ${err instanceof Error ? err.message : 'parse error'}`);
        return;
      }
    }
    const metadata: Record<string, unknown> = { ...extra };
    if (simSpeakerId.trim()) metadata.speaker_id = simSpeakerId.trim();
    if (simLanguage.trim()) metadata.language = simLanguage.trim();
    // Validate BEFORE calling the hook — it throws past MAX_METADATA_BYTES, and
    // a size problem reads better as an inline field error than a toast.
    const size = JSON.stringify(metadata).length;
    if (size > MAX_METADATA_BYTES) {
      setSendError(`Metadata exceeds ${MAX_METADATA_BYTES} bytes (currently ${size}).`);
      return;
    }
    try {
      // Empty buffer: v2 owns capture/transport, this hook is a metadata sink
      // (TASK-564 §6 F1) — the metadata round-trips onto the NEXT onTranscript.
      stt.sendAudioData(new ArrayBuffer(0), metadata);
      setLastSentMetadata(metadata);
      toast.success('Metadata queued — check the next transcript line for the round-trip.');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send metadata');
    }
  };

  // ---------------------------------------------------------------------------
  // Per-mic rows + auto-tag (TASK-597 lane C, R5).
  // ---------------------------------------------------------------------------

  const addRow = useCallback(() => {
    rowIdCounterRef.current += 1;
    const n = rowIdCounterRef.current;
    setRows((prev) => [...prev, { id: `mic-${n}`, mic: String(n), speaker: String(n), json: '{}' }]);
  }, []);

  const removeRow = useCallback((id: string) => {
    // Never go empty — a zero-row list has nothing for auto-tag to alternate through.
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)));
    setRowErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const updateRow = useCallback((id: string, patch: Partial<Pick<MetadataMicRow, 'mic' | 'speaker' | 'json'>>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const sendRow = useCallback(
    (id: string) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      const result = buildRowMetadata(row);
      if ('error' in result) {
        setRowErrors((prev) => ({ ...prev, [id]: result.error }));
        return;
      }
      setRowErrors((prev) => (prev[id] ? { ...prev, [id]: null } : prev));
      try {
        stt.sendAudioData(new ArrayBuffer(0), result.metadata);
        setLastSentMetadata(result.metadata);
        toast.success(`Metadata queued for mic ${row.mic || row.id} — check the next transcript line.`);
      } catch (err) {
        setRowErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : 'Failed to send metadata' }));
      }
    },
    [rows, stt.sendAudioData],
  );

  const syncRowsFromSources = useCallback((sources: Array<{ id: string; micLabel: string }>) => {
    if (sources.length === 0) return;
    setRows((prev) =>
      sources.map((source, index) => {
        // `micLabel` is "mic N" (see `PlaygroundAudioSource`) — reuse N so the
        // synced rows read the same as the manual default (`{mic: '1', ...}`).
        const match = /(\d+)\s*$/.exec(source.micLabel);
        const n = match ? match[1] : String(index + 1);
        const existing = prev[index];
        return { id: `mic-${source.id}`, mic: n, speaker: n, json: existing?.json ?? '{}' };
      }),
    );
    rowIdCounterRef.current = Math.max(rowIdCounterRef.current, sources.length);
  }, []);

  // Fires the NEXT row in rotation and advances the cursor. Kept OUTSIDE any
  // `setState` updater — an updater can run more than once per commit (React
  // Strict Mode replays it), and `sendAudioData` is a real side effect that
  // must fire exactly once per crossing.
  const fireAutoTag = useCallback(() => {
    const currentRows = rowsRef.current;
    if (currentRows.length === 0) return;
    const idx = autoTagCursorRef.current % currentRows.length;
    const row = currentRows[idx];
    autoTagCursorRef.current = (idx + 1) % currentRows.length;
    const result = buildRowMetadata(row);
    if ('error' in result) {
      // Auto-tag is a background loop — a bad row surfaces via its own inline
      // error the next time the developer opens that row, not a toast storm.
      setRowErrors((prev) => ({ ...prev, [row.id]: result.error }));
      return;
    }
    try {
      stt.sendAudioData(new ArrayBuffer(0), result.metadata);
      setLastSentMetadata(result.metadata);
    } catch {
      // Non-fatal — same reasoning as above.
    }
  }, [stt.sendAudioData]);

  // Poll the single input-level meter (`useAudioCapture.getDeviceStatus()` —
  // there is no PER-MIC level yet; that needs lane A's per-source metering) and
  // rising-edge-debounce it: fire once when the level crosses `autoTagThreshold`
  // going up, then require it to drop back below before firing again. One
  // utterance ⇒ one emit, not one per 200 ms poll tick.
  useEffect(() => {
    if (!autoTagEnabled || !capture.isRecording) {
      autoTagAboveRef.current = false;
      return;
    }
    const POLL_MS = 200;
    const interval = setInterval(() => {
      void getDeviceStatusRef.current().then((status) => {
        const level = status?.audioLevel ?? 0;
        const isAbove = level >= autoTagThreshold;
        if (isAbove && !autoTagAboveRef.current) {
          autoTagAboveRef.current = true;
          fireAutoTag();
        } else if (!isAbove) {
          autoTagAboveRef.current = false;
        }
      });
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [autoTagEnabled, capture.isRecording, autoTagThreshold, fireAutoTag]);

  // Only this projection is memoized: it is recomputed on every interim update
  // otherwise, and the summarization tab re-renders on it. The context value
  // itself is intentionally NOT memoized — this provider re-renders exactly
  // when its own state changes, so a fresh object per render is already minimal
  // and a dependency array over ~20 values would be a stale-value trap.
  const lineTexts = useMemo(() => lines.map((line) => line.text), [lines]);

  const value: PlaygroundSessionContextValue = {
    config,
    session: {
      id: mgr.session?.id,
      status: mgr.session?.status ?? 'none',
      error: mgr.error?.message ?? null,
      isPreSession,
    },
    capture: {
      isRecording: capture.isRecording,
      isStarting,
      // Precedence is deliberate: while stopping, `capture.isRecording` is
      // ALREADY false (the SDK released the mic on click), so `stopping` has to
      // be tested before `recording` or the drain would read as `idle`.
      phase: isStarting ? 'starting' : isStopping ? 'stopping' : capture.isRecording ? 'recording' : 'idle',
      start,
      stop,
    },
    transcript: {
      lines,
      lineTexts,
      interim,
      error: stt.error?.message ?? null,
      clear: () => {
        setLines([]);
        setInterim('');
      },
    },
    language: {
      modes,
      mode: languageMode,
      setMode: handleLanguageModeChange,
      catalogError: languageModes.error?.message ?? null,
    },
    metadata: {
      speakerId: simSpeakerId,
      setSpeakerId: setSimSpeakerId,
      language: simLanguage,
      setLanguage: setSimLanguage,
      json: simMetadataJson,
      setJson: setSimMetadataJson,
      lastSent: lastSentMetadata,
      send: handleSendMetadata,
      sendError,
      rows,
      addRow,
      removeRow,
      updateRow,
      sendRow,
      rowErrors,
      syncRowsFromSources,
      autoTagEnabled,
      setAutoTagEnabled,
      autoTagThreshold,
      setAutoTagThreshold,
    },
    // Lane A — published as-is; the hook already returns the slice shape.
    audio,
  };

  return <PlaygroundSessionContext.Provider value={value}>{children}</PlaygroundSessionContext.Provider>;
}

/**
 * Read the live session. Throws outside `<PlaygroundSessionProvider>` — which
 * only exists while the console is connected, so a component that calls this
 * must be rendered behind the `connected` guard in `App.tsx`.
 */
export function usePlaygroundSession(): PlaygroundSessionContextValue {
  const value = useContext(PlaygroundSessionContext);
  if (value === null) {
    throw new Error(
      'usePlaygroundSession() must be used inside <PlaygroundSessionProvider>. ' +
        'The provider is mounted in App.tsx only while the playground is connected — ' +
        'render this component behind that guard.',
    );
  }
  return value;
}
