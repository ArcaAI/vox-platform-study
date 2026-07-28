'use client';

/**
 * @arcaai/vox/compat - useArcaSpeechToText
 *
 * v1 live-STT hook reproduced over v2's pull-state model (TASK-560 §5.3),
 * hardened per the frozen metadata-passthrough contract (TASK-564 §5, TASK-565).
 *
 * v1 pushed transcripts through an `onTranscript(text, isFinal, metadata)`
 * callback; v2 exposes `transcriptSegments[]` (final) + `currentTranscript`
 * (interim) in the store. This hook SYNTHESIZES the v1 callback by observing
 * those store selectors and diffing:
 *  - each NEW final segment  → `onTranscript(text, true,  meta)`
 *  - a changed interim value → `onTranscript(text, false, meta)`
 *
 * Final text is formatted through `transcriptTemplate` (default
 * `"{timestamp} {speaker_id}: {text}"` — v1 parity). Interim text is delivered
 * raw: interims carry no diarization/timestamp, so the speaker/timestamp slots
 * of the template are meaningless for them.
 *
 * `startTranscription()`/`stopTranscription()` drive the SAME `useArcaAudio()`
 * instance as `useAudioCapture`, guarded by `audio.isCapturing` (idempotent).
 *
 * `sendAudioData(data, metadata)` is a METADATA SINK (TASK-560 §5.3 / §6 F1): it
 * records `{device_id, role, chunk_id, …}`-style metadata onto a bounded,
 * capture-relative TIMELINE (E2) and NEVER pushes PCM — v2 owns capture and
 * transport. Delivered metadata is composed in the §5.2 precedence order so
 * caller keys are never silently overwritten by hook enrichments (defect F4).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useArcaAudio } from '../hooks/useArcaAudio';
import { useAgenticStore, selectCurrentTranscript } from '../store/agenticStore';
import type { TranscriptSegment } from '../types/audio';
import type { AgenticState } from '../store/agenticStore';
import type { ErrorInfo } from './types';
import {
  applyTemplate,
  composeDeliveredMetadata,
  pickMetadataForFinal,
  pickMetadataForInterim,
  MAX_METADATA_BYTES,
  METADATA_TIMELINE_CAP,
  type TimelineEntry,
} from './speechToTextMetadata';

export interface UseArcaSpeechToTextProps {
  sessionId: string;
  language: string;
  options?: Record<string, unknown>;
  /** e.g. `"{timestamp} {speaker_id}: {text}"`. Defaults to that when absent. */
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

  // Capture-relative metadata TIMELINE (E2). Replaces the single sticky bag:
  // each sendAudioData appends {atMs, metadata}; finals correlate by startTime,
  // interims use most-recent. `captureStartMs` anchors the capture-relative base.
  const metadataTimelineRef = useRef<TimelineEntry[]>([]);
  const captureStartMsRef = useRef<number | undefined>(undefined);

  // Diff cursor for finals already surfaced.
  const seenFinalCountRef = useRef(0);
  // Last interim value surfaced (avoids duplicate interim callbacks).
  const lastInterimRef = useRef('');

  // Final segments → onTranscript(text, true, meta).
  useEffect(() => {
    for (let i = seenFinalCountRef.current; i < segments.length; i += 1) {
      const seg = segments[i];
      if (!seg?.isFinal) continue;
      const callerMeta = pickMetadataForFinal(metadataTimelineRef.current, seg.startTime, captureStartMsRef.current);
      const text = applyTemplate(transcriptTemplate, {
        text: seg.text,
        speakerId: seg.speakerLabel,
        timestamp: String(seg.startTime ?? ''),
      });
      onTranscriptRef.current(text, true, composeDeliveredMetadata({ seg, isFinal: true, callerMeta }));
    }
    seenFinalCountRef.current = segments.length;
  }, [segments, transcriptTemplate]);

  // Interim currentTranscript → onTranscript(text, false, meta). Text stays raw
  // (interims have no speaker/timestamp to template).
  useEffect(() => {
    if (currentTranscript && currentTranscript !== lastInterimRef.current) {
      lastInterimRef.current = currentTranscript;
      const callerMeta = pickMetadataForInterim(metadataTimelineRef.current);
      onTranscriptRef.current(currentTranscript, false, composeDeliveredMetadata({ seg: {}, isFinal: false, callerMeta }));
    }
  }, [currentTranscript]);

  const startTranscription = useCallback(async (): Promise<void> => {
    if (audio.isCapturing) return; // coordinated with useAudioCapture (idempotent)
    try {
      setError(null);
      // Anchor the capture-relative timeline base at capture start.
      if (captureStartMsRef.current === undefined) captureStartMsRef.current = Date.now();
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
      // Reset the timeline for a clean re-open.
      metadataTimelineRef.current = [];
      captureStartMsRef.current = undefined;
    } catch (err) {
      const info = toErrorInfo(err);
      setError(info);
      onError?.(info);
      throw err;
    }
  }, [audio, onError]);

  const sendAudioData = useCallback((_audioData: ArrayBuffer, metadata?: Record<string, unknown>): void => {
    // Metadata sink ONLY — v2 owns capture/transport, so PCM is never pushed
    // (TASK-560 §6 F1). Record the turn metadata onto the capture-relative
    // timeline for the next synthesized onTranscript(); PCM is intentionally ignored.
    if (metadata && JSON.stringify(metadata).length > MAX_METADATA_BYTES) {
      throw new Error('Audio frame metadata exceeds 8192 bytes');
    }
    const captureStart = captureStartMsRef.current;
    const atMs = captureStart !== undefined ? Date.now() - captureStart : 0;
    const timeline = metadataTimelineRef.current;
    timeline.push({ atMs, metadata });
    if (timeline.length > METADATA_TIMELINE_CAP) timeline.shift(); // drop-oldest
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
