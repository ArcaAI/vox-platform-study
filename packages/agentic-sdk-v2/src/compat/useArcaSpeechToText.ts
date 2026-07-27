'use client';

/**
 * @arcaai/vox/compat - useArcaSpeechToText
 *
 * v1 live-STT hook reproduced over v2's pull-state model (TASK-560 §5.3).
 *
 * v1 pushed transcripts through an `onTranscript(text, isFinal, metadata)`
 * callback; v2 exposes `transcriptSegments[]` (final) + `currentTranscript`
 * (interim) in the store. This hook SYNTHESIZES the v1 callback by observing
 * those store selectors and diffing:
 *  - each NEW final segment  → `onTranscript(text, true,  meta)`
 *  - a changed interim value → `onTranscript(text, false, meta)`
 * formatted through the optional `transcriptTemplate` (`{timestamp} {speaker_id}: {text}`).
 *
 * `startTranscription()`/`stopTranscription()` drive the SAME `useArcaAudio()`
 * instance as `useAudioCapture`, guarded by `audio.isCapturing` (idempotent).
 *
 * `sendAudioData(data, metadata)` is a METADATA SINK (TASK-560 §5.3 / §6 F1): it
 * records `{deviceid, role}`-style metadata for the current turn and NEVER pushes
 * PCM — v2 owns capture and transport.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useArcaAudio } from '../hooks/useArcaAudio';
import { useAgenticStore, selectCurrentTranscript } from '../store/agenticStore';
import type { TranscriptSegment } from '../types/audio';
import type { AgenticState } from '../store/agenticStore';
import type { ErrorInfo } from './types';

export interface UseArcaSpeechToTextProps {
  sessionId: string;
  language: string;
  options?: Record<string, unknown>;
  /** e.g. `"{timestamp} {speaker_id}: {text}"`. */
  transcriptTemplate?: string;
  onTranscript: (text: string, isFinal: boolean, metadata?: Record<string, unknown>) => void;
  onError?: (error: ErrorInfo) => void;
  onStatus?: (status: string, data?: unknown) => void;
}

export interface UseArcaSpeechToTextReturn {
  transcript: string;
  startTranscription: () => Promise<void>;
  stopTranscription: () => Promise<void>;
  /** Metadata sink — records turn metadata; NEVER pushes PCM (v2 owns transport). */
  sendAudioData: (audioData: ArrayBuffer, metadata?: Record<string, unknown>) => void;
  uploadAudioFile: (file: File, language: string, provider?: string) => Promise<string>;
  getTranscriptionStatus: (taskId: string) => Promise<unknown>;
  isUploading: boolean;
  uploadProgress: number;
  error: ErrorInfo | null;
}

const selectTranscriptSegments = (state: AgenticState): TranscriptSegment[] => state.transcriptSegments ?? [];

/** Apply the v1 `transcriptTemplate` (no-op when absent). */
function applyTemplate(template: string | undefined, parts: { text: string; speakerId?: string; timestamp?: string }): string {
  if (!template) return parts.text;
  return template
    .replace(/\{text\}/g, parts.text)
    .replace(/\{speaker_id\}/g, parts.speakerId ?? '')
    .replace(/\{timestamp\}/g, parts.timestamp ?? '');
}

function toErrorInfo(err: unknown): ErrorInfo {
  return {
    code: 'TRANSCRIPTION_ERROR',
    message: err instanceof Error ? err.message : String(err),
    severity: 'high',
    category: 'processing',
  };
}

export function useArcaSpeechToText(props: UseArcaSpeechToTextProps): UseArcaSpeechToTextReturn {
  const { language, transcriptTemplate, onTranscript, onError } = props;
  const audio = useArcaAudio();

  const segments = useAgenticStore(selectTranscriptSegments);
  const currentTranscript = useAgenticStore(selectCurrentTranscript);

  const [error, setError] = useState<ErrorInfo | null>(null);

  // Keep callbacks fresh without re-subscribing the diff effects.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  // Metadata sink for the current turn (deviceid/role). NEVER carries PCM.
  const turnMetadataRef = useRef<Record<string, unknown> | undefined>(undefined);

  // Diff cursor for finals already surfaced.
  const seenFinalCountRef = useRef(0);
  // Last interim value surfaced (avoids duplicate interim callbacks).
  const lastInterimRef = useRef('');

  // Final segments → onTranscript(text, true, meta).
  useEffect(() => {
    for (let i = seenFinalCountRef.current; i < segments.length; i += 1) {
      const seg = segments[i];
      if (!seg?.isFinal) continue;
      const text = applyTemplate(transcriptTemplate, {
        text: seg.text,
        speakerId: seg.speakerLabel,
        timestamp: String(seg.startTime ?? ''),
      });
      onTranscriptRef.current(text, true, {
        ...turnMetadataRef.current,
        speaker_id: seg.speakerLabel,
        confidence: seg.confidence,
        language: seg.language,
        startTime: seg.startTime,
        endTime: seg.endTime,
        isFinal: true,
      });
    }
    seenFinalCountRef.current = segments.length;
  }, [segments, transcriptTemplate]);

  // Interim currentTranscript → onTranscript(text, false, meta).
  useEffect(() => {
    if (currentTranscript && currentTranscript !== lastInterimRef.current) {
      lastInterimRef.current = currentTranscript;
      const text = applyTemplate(transcriptTemplate, { text: currentTranscript });
      onTranscriptRef.current(text, false, { ...turnMetadataRef.current, isFinal: false });
    }
  }, [currentTranscript, transcriptTemplate]);

  const startTranscription = useCallback(async (): Promise<void> => {
    if (audio.isCapturing) return; // coordinated with useAudioCapture (idempotent)
    try {
      setError(null);
      await audio.start({ language });
    } catch (err) {
      const info = toErrorInfo(err);
      setError(info);
      onError?.(info);
      throw err;
    }
  }, [audio, language, onError]);

  const stopTranscription = useCallback(async (): Promise<void> => {
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

  const sendAudioData = useCallback((_audioData: ArrayBuffer, metadata?: Record<string, unknown>): void => {
    // Metadata sink ONLY — v2 owns capture/transport, so PCM is never pushed
    // (TASK-560 §6 F1). Record the turn metadata for the next synthesized
    // onTranscript(); the audio buffer is intentionally ignored.
    if (metadata) turnMetadataRef.current = metadata;
  }, []);

  const uploadAudioFile = useCallback(async (): Promise<string> => {
    throw new Error('[@arcaai/vox/compat] uploadAudioFile is not supported. Use the v2 file-transcription API (FileTranscriptionService).');
  }, []);

  const getTranscriptionStatus = useCallback(async (): Promise<unknown> => {
    throw new Error('[@arcaai/vox/compat] getTranscriptionStatus is not supported. Read live state from useArcaAudio().transcriptSegments.');
  }, []);

  const transcript = useMemo(() => {
    const finals = segments.map((s) => s.text).join(' ');
    return currentTranscript ? `${finals}${finals ? ' ' : ''}${currentTranscript}` : finals;
  }, [segments, currentTranscript]);

  return {
    transcript,
    startTranscription,
    stopTranscription,
    sendAudioData,
    uploadAudioFile,
    getTranscriptionStatus,
    isUploading: false,
    uploadProgress: 0,
    error,
  };
}
