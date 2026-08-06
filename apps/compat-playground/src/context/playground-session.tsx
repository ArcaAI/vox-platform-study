import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
// `useArcaSttLanguageModes` is a v2-native hook (TASK-587) with no v1 ancestor.
// It MUST be imported from `@arcaai/vox/compat` — the SAME entry bundle as
// `<ArcaCompatProvider>` — because the store React context does not cross
// entry-point bundles (tsup `splitting: false`). Importing it from
// `@arcaai/vox/core` makes `useStoreApi()` read a different context instance
// and throw "must be used within an <AgenticProvider>".
import { useArcaSessionManager, useAudioCapture, useArcaSpeechToText, useArcaSttLanguageModes, useArcaBatchTranscription } from '@arcaai/vox/compat';
import type { BatchQueueItem } from '@arcaai/vox/compat';
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

/**
 * Stop-drain tuning (TASK-597) — PER-CAPTURE, unlike the noise-suppression/VAD
 * switches, which are connection-level and live on the Connection tab.
 *
 * These ride `AudioStartOptions` on each `startRecording()`, so a developer can
 * change them between runs without remounting `<ArcaCompatProvider>`.
 *
 * Both are `undefined` by default, which means "use the SDK default"
 * (1500 ms ceiling / 250 ms quiet window) — nothing changes unless opted into.
 */
export interface PlaygroundDrainSlice {
  /** Hard ceiling on the drain wait. `undefined` ⇒ SDK default. */
  timeoutMs: number | undefined;
  setTimeoutMs: (value: number | undefined) => void;
  /**
   * Silence after `finalizing` that ends the drain early. **`0` disables the
   * early resolve** — the socket then stays open for the tail final until the
   * server's terminal status or `timeoutMs`. `undefined` ⇒ SDK default.
   */
  quietWindowMs: number | undefined;
  setQuietWindowMs: (value: number | undefined) => void;
  /** One-click preset: `quietWindowMs = 0` + a long ceiling. */
  applyWaitForTailFinal: () => void;
  /** Restore both to `undefined` (the SDK defaults). */
  resetToDefaults: () => void;
}

/**
 * The "wait for the tail final" preset.
 *
 * The default 250 ms quiet window resolves the drain almost immediately after
 * the backend reports `finalizing`, which on a GGUF/whisper.cpp pipeline lands
 * seconds before the last transcript — so the socket closes and the tail final
 * is never delivered to the browser. `0` + a long ceiling is the configuration
 * that actually waits for it.
 */
export const WAIT_FOR_TAIL_FINAL_TIMEOUT_MS = 60_000;

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
   * Opt-in switch: while recording, tag the turn automatically whenever the
   * input level crosses `autoTagThreshold`. WHICH row is sent depends on
   * {@link PlaygroundMetadataSlice.autoTagMode} — see that field; it is the
   * difference between real attribution and a rotation.
   */
  autoTagEnabled: boolean;
  setAutoTagEnabled: (v: boolean) => void;
  /** 0–100, same scale as the SDK's input-level meter. */
  autoTagThreshold: number;
  setAutoTagThreshold: (v: number) => void;
  /**
   * How auto-tag is CURRENTLY deciding which row to send — derived from what
   * the SDK actually offers this run, not from a setting. The UI states it
   * verbatim; the three values are genuinely different guarantees:
   *
   *  - `per-source`   — two or more live per-source meters: the LOUDEST source
   *                     above threshold owns the turn, and a change of loudest
   *                     source mid-utterance re-tags. Real per-mic attribution,
   *                     bounded only by acoustic bleed between mics.
   *  - `single-source`— exactly one source: every turn is attributed to it,
   *                     which is exactly right for "which INPUT", and says
   *                     nothing about which PERSON — one mic cannot separate
   *                     two speakers.
   *  - `unavailable`  — no per-source signal at all (not recording, or a
   *                     runtime without Web Audio analysis). Falls back to the
   *                     pre-follow-up ROUND-ROBIN rotation over the rows, which
   *                     is a demo of the payload shape, NOT attribution.
   */
  autoTagMode: PlaygroundAutoTagMode;
}

/** See {@link PlaygroundMetadataSlice.autoTagMode}. */
export type PlaygroundAutoTagMode = 'per-source' | 'single-source' | 'unavailable';

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
  /**
   * Live PER-SOURCE input level (0–100), index-aligned with {@link sources}
   * (TASK-597 follow-up #2). Sampled from an analysis-only `AnalyserNode` per
   * mixer source inside the SDK — this is what makes "which mic is speaking"
   * answerable at all; the mixed `getDeviceStatus().audioLevel` cannot.
   *
   * `[]` = the SDK has no per-source signal (not recording, or a runtime
   * without Web Audio analysis). Consumers must degrade honestly on `[]`
   * rather than inferring attribution.
   */
  sourceLevels: number[];
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
 * Batch (pre-recorded file) transcription — the Batch-upload tab (TASK-603).
 *
 * A NEW top-level group rather than a widening of `audio`: `audio` is the LIVE
 * capture graph (mics, decoded files fed through the mixer, per-source levels),
 * while this is an upload queue that never touches the capture graph at all.
 *
 * It lives here, above the tabs, for the same reason the capture session does:
 * an upload takes minutes and its SSE result stream must survive a tab switch.
 * Everything except the local UI state is `useArcaBatchTranscription()` verbatim.
 */
export interface PlaygroundBatchSlice {
  /** One row per queued file, in enqueue order. */
  items: BatchQueueItem[];
  /** Queue files with the tab's pipeline + the console-wide language mode. */
  enqueue: (files: File[]) => void;
  cancel: (itemId: string) => void;
  retry: (itemId: string) => void;
  remove: (itemId: string) => void;
  clear: () => void;
  isUploading: boolean;
  /** Rows currently holding a concurrency slot (uploading OR streaming). */
  activeCount: number;
  /** Last batch error, for the tab's single error surface. */
  error: string | null;

  /**
   * Pipeline for the NEXT enqueue. Seeded from the connection config but
   * independently changeable — running a batch against a different ASR pipeline
   * is the most common reason to open this tab at all. Already-queued rows keep
   * the pipeline they were enqueued with (the hook snapshots it per item).
   */
  pipelineId: string;
  setPipelineId: (value: string) => void;
  /** Files in flight at once, counting upload AND result stream. */
  concurrency: number;
  setConcurrency: (value: number) => void;

  /** Which row the result panel is showing. */
  selectedId: string | null;
  select: (itemId: string | null) => void;

  /**
   * Transcript pushed toward the Summarization tab. Token-keyed so `SummaryCard`
   * applies each push exactly once and a later manual edit is never clobbered
   * by a re-render.
   */
  handoff: { token: number; text: string } | null;
  sendToSummarization: (text: string) => void;
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
  drain: PlaygroundDrainSlice;
  transcript: PlaygroundTranscriptSlice;
  language: PlaygroundLanguageSlice;
  metadata: PlaygroundMetadataSlice;
  audio: PlaygroundAudioSlice;
  batch: PlaygroundBatchSlice;
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
  // Stop-drain knobs (TASK-597), seeded from the persisted config. Per-capture,
  // so they are plain state here rather than part of the provider config.
  const [drainTimeoutMs, setDrainTimeoutMs] = useState<number | undefined>(config.drainTimeoutMs);
  const [quietWindowMs, setQuietWindowMs] = useState<number | undefined>(config.quietWindowMs);

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
  // Index of the source that owned the last emitted turn, in per-source mode.
  // A CHANGE of loudest source while the level stays up is a speaker change, so
  // it re-tags without waiting for silence — that is the whole point of having
  // a per-mic signal (TASK-597 follow-up #2).
  const autoTagDominantRef = useRef<number | null>(null);

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
  // The drain knobs (TASK-597) ride the SAME hook for the same reason: they are
  // `AudioStartOptions` fields, applied by whichever hook wins the start race,
  // and that is this one. Spread on `!== undefined` — `0` is a real value for
  // `quietWindowMs` (it disables the early resolve), so a truthiness check here
  // would drop exactly the setting a tail-final run depends on.
  // And the PIPELINE ID rides it for the same reason (TASK-614 D-1): passing it
  // only to `useArcaSpeechToText` below meant the winning start carried none, so
  // the session ran the gateway-resolved tenant default and `activePipeline`
  // stayed null — which `useArcaSttProvider` reads as "capture has not started",
  // silently turning the mid-session STT-engine toggle into a no-op.
  const capture = useAudioCapture({
    options: { sttPipelineId: config.pipelineId.trim() || undefined },
    language: languageMode,
    languageMode,
    ...audio.captureOptions,
    ...(drainTimeoutMs !== undefined ? { drainTimeoutMs } : {}),
    ...(quietWindowMs !== undefined ? { quietWindowMs } : {}),
  });
  // "Keep it fresh" ref for the level-status reader (same pattern as
  // `onTranscriptRef` in `useArcaSpeechToText.ts`) — avoids putting
  // `capture.getDeviceStatus` (which changes identity whenever `audio.level`
  // ticks, ~10x/second while recording) in the auto-tag effect's dependency
  // array, which would tear the poll interval down and recreate it before it
  // ever gets a chance to fire.
  const getDeviceStatusRef = useRef(capture.getDeviceStatus);
  getDeviceStatusRef.current = capture.getDeviceStatus;
  // Live PER-SOURCE levels (TASK-597 follow-up #2). Same "keep it fresh" ref
  // pattern and for the same reason: the array is a new identity on every
  // ~100ms store tick, so it must not be an effect dependency.
  const sourceLevels = capture.sourceLevels ?? [];
  const sourceLevelsRef = useRef<number[]>(sourceLevels);
  sourceLevelsRef.current = sourceLevels;
  // What auto-tag can honestly claim RIGHT NOW — derived from the signal that
  // actually exists, never from a user setting.
  const autoTagMode: PlaygroundAutoTagMode = sourceLevels.length > 1 ? 'per-source' : sourceLevels.length === 1 ? 'single-source' : 'unavailable';
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

  // ---------------------------------------------------------------------------
  // Batch upload (TASK-603) — mounted HERE, above the tabs, so a multi-minute
  // upload and its SSE result stream survive every tab switch, exactly like the
  // live capture session does.
  // ---------------------------------------------------------------------------
  const [batchPipelineId, setBatchPipelineId] = useState(config.pipelineId);
  const [batchConcurrency, setBatchConcurrency] = useState(2);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [batchHandoff, setBatchHandoff] = useState<{ token: number; text: string } | null>(null);
  const handoffTokenRef = useRef(0);

  const batch = useArcaBatchTranscription({
    options: { pipelineId: batchPipelineId.trim() || undefined, language: languageMode },
    concurrency: batchConcurrency,
    onJobCompleted: (item) => toast.success(`Transcribed ${item.fileName}.`),
    onError: (err) => toast.error(`Batch error: ${err.message}`),
  });

  const enqueueBatch = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const ids = batch.enqueue(files);
      // Select the first file of the batch so the result panel is never an
      // empty box while something is visibly uploading next to it.
      setSelectedBatchId((prev) => prev ?? ids[0] ?? null);
      toast.success(`Queued ${files.length} file${files.length === 1 ? '' : 's'}.`);
    },
    [batch],
  );

  const removeBatchItem = useCallback(
    (itemId: string) => {
      batch.remove(itemId);
      setSelectedBatchId((prev) => (prev === itemId ? null : prev));
    },
    [batch],
  );

  const clearBatch = useCallback(() => {
    batch.clear();
    setSelectedBatchId(null);
  }, [batch]);

  const sendToSummarization = useCallback((text: string) => {
    handoffTokenRef.current += 1;
    setBatchHandoff({ token: handoffTokenRef.current, text });
    toast.success('Transcript sent to the Summarization tab.');
  }, []);

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
      // The drain is over — the socket is closed and no further final can
      // arrive. A leftover interim (a silence-period partial the ASR never
      // finalized) would otherwise sit in the transcript as an italic
      // "in progress" line forever, reading as "the last line is still being
      // finalized" when nothing is pending anymore.
      setInterim('');
      setIsStopping(false);
    }
  };

  const handleLanguageModeChange = (modeId: string) => {
    setLanguageMode(modeId);
    // Persist across reloads — does not touch the `connected` state in App.tsx,
    // so it never remounts `<ArcaCompatProvider>`.
    saveStoredConfig({ ...config, languageMode: modeId });
  };

  // Persist the drain knobs the same way the language mode is persisted — write
  // through `saveStoredConfig` WITHOUT touching `connected` in App.tsx, so the
  // SDK provider is never remounted and a live session survives the change.
  const persistDrain = (next: { drainTimeoutMs?: number; quietWindowMs?: number }) => {
    saveStoredConfig({ ...config, drainTimeoutMs, quietWindowMs, ...next });
  };

  const handleDrainTimeoutChange = (value: number | undefined) => {
    setDrainTimeoutMs(value);
    persistDrain({ drainTimeoutMs: value });
  };

  const handleQuietWindowChange = (value: number | undefined) => {
    setQuietWindowMs(value);
    persistDrain({ quietWindowMs: value });
  };

  const applyWaitForTailFinal = () => {
    setDrainTimeoutMs(WAIT_FOR_TAIL_FINAL_TIMEOUT_MS);
    setQuietWindowMs(0);
    persistDrain({ drainTimeoutMs: WAIT_FOR_TAIL_FINAL_TIMEOUT_MS, quietWindowMs: 0 });
  };

  const resetDrainToDefaults = () => {
    setDrainTimeoutMs(undefined);
    setQuietWindowMs(undefined);
    // Explicit `undefined` so the stored object loses the keys rather than
    // keeping the previous override (JSON.stringify drops undefined values).
    saveStoredConfig({ ...config, drainTimeoutMs: undefined, quietWindowMs: undefined });
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

  // Sends ONE row. Kept OUTSIDE any `setState` updater — an updater can run
  // more than once per commit (React Strict Mode replays it), and
  // `sendAudioData` is a real side effect that must fire exactly once per
  // crossing.
  const fireAutoTagRow = useCallback(
    (row: MetadataMicRow) => {
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
    },
    [stt.sendAudioData],
  );

  /**
   * PER-SOURCE emit (TASK-597 follow-up #2): tag the turn with the row that
   * belongs to the source the SDK says is loudest.
   *
   * Rows and sources line up 1:1 after "Sync rows from audio sources"; the
   * modulo keeps a hand-edited shorter list usable instead of silently
   * dropping the tag for the extra mics.
   */
  const fireAutoTagForSource = useCallback(
    (sourceIndex: number) => {
      const currentRows = rowsRef.current;
      if (currentRows.length === 0) return;
      fireAutoTagRow(currentRows[sourceIndex % currentRows.length]);
    },
    [fireAutoTagRow],
  );

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

  // ---------------------------------------------------------------------------
  // Auto-tag poll (TASK-597 follow-up #2 — real per-mic attribution).
  //
  // TWO paths, and which one runs is decided by what the SDK actually offers:
  //
  //  • PER-SOURCE (`capture.sourceLevels` non-empty). The loudest source above
  //    the threshold owns the turn. Rising-edge debounced exactly as before —
  //    one sustained utterance ⇒ one emit — PLUS a re-tag when the loudest
  //    source CHANGES while the level stays up, because that is a speaker
  //    change and waiting for silence would attribute it to the wrong mic.
  //
  //  • FALLBACK (`sourceLevels` empty ⇒ no per-source signal). The pre-597
  //    behaviour: poll the single MIXED meter and rotate round-robin through
  //    the rows. This is a demonstration of the payload shape, not attribution,
  //    and the UI says so — the honest disclosure was never removed, it now
  //    only appears when it is actually true.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!autoTagEnabled || !capture.isRecording) {
      autoTagAboveRef.current = false;
      autoTagDominantRef.current = null;
      return;
    }
    const POLL_MS = 200;
    const interval = setInterval(() => {
      const levels = sourceLevelsRef.current;

      if (levels.length > 0) {
        let dominant = 0;
        for (let i = 1; i < levels.length; i += 1) {
          if ((levels[i] ?? 0) > (levels[dominant] ?? 0)) dominant = i;
        }
        const peak = levels[dominant] ?? 0;
        if (peak >= autoTagThreshold) {
          if (!autoTagAboveRef.current || autoTagDominantRef.current !== dominant) {
            autoTagAboveRef.current = true;
            autoTagDominantRef.current = dominant;
            fireAutoTagForSource(dominant);
          }
        } else {
          autoTagAboveRef.current = false;
          autoTagDominantRef.current = null;
        }
        return;
      }

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
  }, [autoTagEnabled, capture.isRecording, autoTagThreshold, fireAutoTag, fireAutoTagForSource]);

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
    drain: {
      timeoutMs: drainTimeoutMs,
      setTimeoutMs: handleDrainTimeoutChange,
      quietWindowMs,
      setQuietWindowMs: handleQuietWindowChange,
      applyWaitForTailFinal,
      resetToDefaults: resetDrainToDefaults,
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
      autoTagMode,
    },
    // Lane A's slice, with ONE field replaced: the hook cannot see the capture
    // graph (it runs before `useAudioCapture` to build its options), so the
    // live per-source levels are joined on here (TASK-597 follow-up #2).
    audio: { ...audio, sourceLevels },
    batch: {
      items: batch.items,
      enqueue: enqueueBatch,
      cancel: batch.cancel,
      retry: batch.retry,
      remove: removeBatchItem,
      clear: clearBatch,
      isUploading: batch.isUploading,
      activeCount: batch.activeCount,
      error: batch.error?.message ?? null,
      pipelineId: batchPipelineId,
      setPipelineId: setBatchPipelineId,
      concurrency: batchConcurrency,
      setConcurrency: setBatchConcurrency,
      selectedId: selectedBatchId,
      select: setSelectedBatchId,
      handoff: batchHandoff,
      sendToSummarization,
    },
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
