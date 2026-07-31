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
  /** Retained for source-compat only — NEVER invoked (v2 owns PCM transport). */
  onAudioData?: (data: ArrayBuffer) => void;
  onError?: (error: ErrorInfo) => void;
}

export interface UseAudioCaptureReturn {
  isRecording: boolean;
  deviceStatus: AudioDeviceStatus | null;
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
  const { options, autoStart = false, language, languageMode, onError } = props;
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
  }, [audio, options?.sttPipelineId, language, languageMode, pendingSttProvider, setPendingSttProvider, onError]);

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
    startRecording,
    stopRecording,
    getDeviceStatus,
    error,
    isReady: true,
  };
}
