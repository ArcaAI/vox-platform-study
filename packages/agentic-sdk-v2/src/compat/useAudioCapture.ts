'use client';

/**
 * @arcaai/vox/compat - useAudioCapture
 *
 * v1 capture hook reproduced over v2's `useArcaAudio` (TASK-560 §5.3).
 *
 * Coordination (TASK-561 §3.2 option a): this hook and `useArcaSpeechToText`
 * both drive the SAME per-provider `useArcaAudio()` instance. `startRecording()`
 * calls `audio.start(...)` guarded by `audio.isCapturing`, so pairing the two
 * hooks never double-starts the mic. `stopRecording()` calls `audio.stop()`
 * guarded likewise.
 *
 * `onAudioData` is retained for source-compat but is NEVER invoked — v2 owns the
 * capture→mix→noise→VAD→STT pipeline and transport (TASK-560 §2.2.3).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useArcaAudio } from '../hooks/useArcaAudio';
import { useAgenticStore } from '../store/agenticStore';
import type { AudioProcessingConstraints } from '../types';
import type { AudioDeviceStatus, ErrorInfo, V1SdkConfig } from './types';

export interface UseAudioCaptureProps {
  options?: Partial<V1SdkConfig>;
  autoStart?: boolean;
  /**
   * End-user STT language + TASK-587 language mode, chosen BEFORE start. v1's
   * `useAudioCapture` had no language (its STT WS was language-flat); v2 pins the
   * language on `audio.start(...)`. This hook and `useArcaSpeechToText` both drive
   * the SAME `useArcaAudio()` and whichever calls `audio.start` FIRST wins — the
   * playground starts the mic here BEFORE `startTranscription()`, so a
   * language-blind start here would drop the selection to the pipeline/default
   * locale. Forwarding it makes the outcome order-independent. Additive + optional
   * — omit to keep the frozen v1 behavior.
   */
  language?: string;
  languageMode?: string;
  /**
   * Audio SOURCE selection (TASK-597), forwarded verbatim to
   * `useArcaAudio.start(...)`. Before 597 this hook silently dropped every
   * source option: v1's `useAudioCapture` had no device selection, so a v2
   * consumer pairing it with `useArcaSpeechToText` could only ever record the
   * default microphone — the mixer and the injection seam existed in the core
   * hook but were unreachable from the compat surface.
   *
   * Which hook wins the start race matters here (see the coordination note at
   * the top of the file): `startRecording()` and
   * `useArcaSpeechToText.startTranscription()` both call `audio.start(...)`
   * guarded by `audio.isCapturing`, and the first one through applies its
   * options. `useArcaSpeechToText` never carries source options, so these are
   * honoured whenever capture is started HERE — which is the documented order
   * for a capture-first consumer (the compat playground). There is deliberately
   * NO store-backed fallback (as `languageMode`/`pendingSttProvider` have): a
   * `MediaStream` is a live, non-serializable resource whose ownership would
   * become ambiguous if it were parked in the shared store, and unlike a
   * language id it cannot be safely re-applied by whichever hook happens to
   * start. Start capture here when you select sources.
   *
   * All additive/optional — omitting them keeps the frozen v1 behaviour.
   */
  deviceId?: string;
  secondaryDeviceId?: string;
  additionalDeviceIds?: string[];
  /** Pre-built (e.g. file-backed) streams used INSTEAD of `getUserMedia`. */
  sourceStreams?: MediaStream[];
  /** Per-source linear mixer gain, index-aligned with the resolved source list. */
  sourceGains?: number[];
  /**
   * Browser audio-processing switches (TASK-608), forwarded verbatim to
   * `audio.start(...)` and applied to every capture source's `getUserMedia`
   * constraints. Pass `{ echoCancellation: false, noiseSuppression: false,
   * autoGainControl: false }` for raw, un-gained capture.
   *
   * NOT the same switch as v1's `audioSettings.noiseSuppression`, which toggles
   * the SDK's own RNNoise pipeline stage. This one is the BROWSER's DSP, which
   * runs before the SDK sees a single sample and is ON by default in every major
   * browser. An app that wants genuinely unprocessed audio turns off both.
   *
   * Subject to the same start-race rule as the source options above: honoured
   * whenever capture is started HERE, which is the documented order for a
   * capture-first consumer.
   */
  audioProcessing?: AudioProcessingConstraints;
  /**
   * Ceiling (ms) on the streaming-STT stop-drain awaited by `stopRecording()`
   * (TASK-597 follow-up #4). Forwarded verbatim to `audio.start(...)`; omit for
   * the SDK default (1500 ms). Non-positive values are ignored. The mic is
   * released synchronously on stop regardless — this only bounds how long the
   * returned promise waits for the server's last transcript.
   */
  drainTimeoutMs?: number;
  /**
   * Quiet window (ms) that ends the streaming-STT stop-drain early once the
   * backend reports `finalizing` (TASK-597). Forwarded verbatim to
   * `audio.start(...)`; omit for the SDK default (250 ms).
   *
   * **`0` disables the early resolve** and is PRESERVED — only negative values
   * are ignored. Set it to `0` (with a generous `drainTimeoutMs`) when the tail
   * final matters more than teardown latency: on a slow ASR pipeline the last
   * transcript can trail `finalizing` by seconds, and the default quiet window
   * closes the socket long before it arrives.
   */
  quietWindowMs?: number;
  /** Retained for source-compat only — NEVER invoked (v2 owns PCM transport). */
  onAudioData?: (data: ArrayBuffer) => void;
  onError?: (error: ErrorInfo) => void;
}

export interface UseAudioCaptureReturn {
  isRecording: boolean;
  deviceStatus: AudioDeviceStatus | null;
  /**
   * PER-SOURCE input levels (0–100 each), index-aligned with the resolved
   * capture-source order — i.e. with `sourceStreams` when streams are injected,
   * otherwise with `[deviceId, secondaryDeviceId, ...additionalDeviceIds]`
   * (TASK-597 follow-up #2).
   *
   * REACTIVE, unlike `getDeviceStatus()`: it re-renders as the levels change,
   * so a consumer attributing a turn to a microphone does not have to poll.
   * `deviceStatus.audioLevel` is unchanged and remains the single MIXED level —
   * the v1 shape stays frozen.
   *
   * `[]` = no per-source signal (not recording, or a runtime that cannot
   * analyse). Attribution is then genuinely unknown; say so rather than
   * guessing. One entry ⇒ a single-source session, where that source is the
   * whole mix and attribution to it is exact.
   */
  sourceLevels: number[];
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  getDeviceStatus: () => Promise<AudioDeviceStatus | null>;
  error: ErrorInfo | null;
  isReady: boolean;
}

function toErrorInfo(err: unknown): ErrorInfo {
  return {
    code: 'AUDIO_CAPTURE_ERROR',
    message: err instanceof Error ? err.message : String(err),
    severity: 'high',
    category: 'audio',
  };
}

export function useAudioCapture(props: UseAudioCaptureProps = {}): UseAudioCaptureReturn {
  const {
    options,
    autoStart = false,
    language,
    languageMode,
    deviceId,
    secondaryDeviceId,
    additionalDeviceIds,
    sourceStreams,
    sourceGains,
    audioProcessing,
    drainTimeoutMs,
    quietWindowMs,
    onError,
  } = props;
  const audio = useArcaAudio();
  // Pre-start engine selection (TASK-586) chosen via `useArcaSttProvider` before
  // capture — applied to `audio.start` and cleared, mirroring the languageMode
  // store-fallback pattern (order-independent with `useArcaSpeechToText`).
  const pendingSttProvider = useAgenticStore((s) => s.pendingSttProvider);
  const setPendingSttProvider = useAgenticStore((s) => s.setPendingSttProvider);

  const [deviceStatus, setDeviceStatus] = useState<AudioDeviceStatus | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const autoStartedRef = useRef(false);

  const startRecording = useCallback(async (): Promise<void> => {
    // Idempotent: the coordinated STT hook may have already started capture.
    if (audio.isCapturing) return;
    try {
      setError(null);
      await audio.start({
        pipelineId: options?.sttPipelineId,
        ...(language ? { language } : {}),
        ...(languageMode ? { languageMode } : {}),
        ...(pendingSttProvider ? { startOn: pendingSttProvider } : {}),
        // Source selection (TASK-597) — spread only when supplied so a caller
        // that selects nothing still produces the exact pre-597 options object.
        ...(deviceId ? { deviceId } : {}),
        ...(secondaryDeviceId ? { secondaryDeviceId } : {}),
        ...(additionalDeviceIds?.length ? { additionalDeviceIds } : {}),
        ...(sourceStreams?.length ? { sourceStreams } : {}),
        ...(sourceGains?.length ? { sourceGains } : {}),
        // Browser DSP switches (TASK-608) — spread only when at least one key is
        // stated, so a caller that says nothing still produces the exact
        // pre-608 options object.
        ...(audioProcessing && Object.keys(audioProcessing).length > 0 ? { audioProcessing } : {}),
        // Stop-drain ceiling (TASK-597 follow-up #4) — spread only when
        // positive, so the pre-597 options object is byte-identical for every
        // caller that does not set it (and a `0` cannot mean "no drain").
        ...(typeof drainTimeoutMs === 'number' && drainTimeoutMs > 0 ? { drainTimeoutMs } : {}),
        // Quiet window (TASK-597) — spread on `>= 0`, NOT on truthiness. `0` is
        // the "wait for the terminal status, not a lull" setting, so a falsy
        // guard here would drop the one value worth passing explicitly.
        ...(typeof quietWindowMs === 'number' && quietWindowMs >= 0 ? { quietWindowMs } : {}),
      });
      // Consume the pre-start selection so a later re-open starts on primary
      // unless re-selected (order-independent with useArcaSpeechToText).
      if (pendingSttProvider) setPendingSttProvider(null);
    } catch (err) {
      const info = toErrorInfo(err);
      setError(info);
      onError?.(info);
      throw err;
    }
  }, [
    audio,
    options?.sttPipelineId,
    language,
    languageMode,
    pendingSttProvider,
    setPendingSttProvider,
    deviceId,
    secondaryDeviceId,
    additionalDeviceIds,
    sourceStreams,
    sourceGains,
    audioProcessing,
    drainTimeoutMs,
    quietWindowMs,
    onError,
  ]);

  const stopRecording = useCallback(async (): Promise<void> => {
    if (!audio.isCapturing) return;
    try {
      await audio.stop();
    } catch (err) {
      const info = toErrorInfo(err);
      setError(info);
      onError?.(info);
      throw err;
    }
  }, [audio, onError]);

  const getDeviceStatus = useCallback(async (): Promise<AudioDeviceStatus | null> => {
    try {
      const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
      if (!md?.enumerateDevices) return null;
      const devices = await md.enumerateDevices();
      const inputDevices = devices.filter((d) => d.kind === 'audioinput');
      const status: AudioDeviceStatus = {
        inputDevices,
        selectedDevice: inputDevices[0],
        // Presence of device labels implies granted permission.
        permissionStatus: inputDevices.some((d) => d.label) ? 'granted' : 'prompt',
        audioLevel: audio.level,
      };
      setDeviceStatus(status);
      return status;
    } catch {
      return null;
    }
  }, [audio.level]);

  useEffect(() => {
    if (autoStart && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void startRecording();
    }
  }, [autoStart, startRecording]);

  return {
    isRecording: audio.isCapturing,
    deviceStatus,
    // Per-source levels straight off the store (TASK-597 follow-up #2) — no
    // polling, no derived state, and `[]` when the SDK has no signal to give.
    sourceLevels: audio.sourceLevels ?? [],
    startRecording,
    stopRecording,
    getDeviceStatus,
    error,
    isReady: true,
  };
}
