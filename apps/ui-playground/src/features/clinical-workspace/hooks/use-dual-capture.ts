/**
 * useDualCapture (TASK-330 P3, WS3).
 *
 * Owns a {@link DualStreamRecorder} that records the RAW mic stream and the
 * GENUINE post-noise-filter (processed) stream in parallel, then on stop uploads
 * both blobs to storage and registers them via `POST /consultations/:id/recordings
 * { rawMediaId, processedMediaId }`. The processed lane is produced by the SDK's
 * `createProcessedAudioTap` (the same RNNoise filter the transcription pipeline
 * uses); when that tap is unavailable at runtime it falls back to a WebAudio
 * approximation, which is clearly flagged via `processedSource` and a distinct
 * upload filename (`processed-approx-capture.*`).
 *
 * The capture panel drives ordering imperatively: it starts the recorder once the
 * live session exposes its input stream, and calls `stopAndPersist()` BEFORE
 * tearing down the session so the final blobs flush while the mic tracks are
 * still live (the genuine tap never stops the shared mic track itself).
 */
import { useCallback, useRef, useState } from 'react';
import { createProcessedAudioTap, useArcaStore, useStorage, type AgenticClient } from '@arcaai/vox';
import { registerDualRecording } from '../api/clinical-workspace.api';
import { STORAGE_BUCKET } from '../constants';
import { buildDualRecordingInput, DualStreamRecorder, type ProcessedAudioSource } from '../lib/dual-capture';

export type DualCaptureStatus = 'idle' | 'capturing' | 'uploading' | 'saved' | 'error';

export interface DualCapturePersistResult {
  rawMediaId: string;
  processedMediaId: string;
  /** Whether the processed artifact is the genuine post-DSP PCM or the fallback. */
  processedSource: ProcessedAudioSource;
}

export interface UseDualCaptureResult {
  status: DualCaptureStatus;
  error: string | null;
  isCapturing: boolean;
  lastResult: DualCapturePersistResult | null;
  /** Source of the most recent processed artifact (`null` until captured). */
  processedSource: ProcessedAudioSource | null;
  start: (inputStream: MediaStream) => void;
  stopAndPersist: () => Promise<DualCapturePersistResult | null>;
  reset: () => void;
}

function fileExtensionFor(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4')) return 'm4a';
  return 'webm';
}

/** Distinct filename so a fallback (approximation) artifact is obvious in storage. */
function processedFileName(source: ProcessedAudioSource, ext: string): string {
  return source === 'noise-filter' ? `processed-capture.${ext}` : `processed-approx-capture.${ext}`;
}

export function useDualCapture(consultationId: string | null): UseDualCaptureResult {
  const apiClient = useArcaStore((s: { apiClient: AgenticClient | null }) => s.apiClient);
  const storage = useStorage();

  const recorderRef = useRef<DualStreamRecorder | null>(null);
  const [status, setStatus] = useState<DualCaptureStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<DualCapturePersistResult | null>(null);
  const [processedSource, setProcessedSource] = useState<ProcessedAudioSource | null>(null);

  const start = useCallback((inputStream: MediaStream) => {
    if (recorderRef.current) return;
    try {
      // Record the GENUINE post-noise-filter PCM via the SDK tap (same RNNoise
      // filter as the pipeline). The recorder falls back to its WebAudio
      // approximation if the tap can't initialise in this browser.
      const recorder = new DualStreamRecorder(inputStream, {
        processedTapFactory: (raw) => createProcessedAudioTap(raw, { level: 'high' }),
      });
      recorder.start();
      recorderRef.current = recorder;
      setStatus('capturing');
      setError(null);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to start dual capture');
    }
  }, []);

  const stopAndPersist = useCallback(async (): Promise<DualCapturePersistResult | null> => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return null;

    try {
      const captured = await recorder.stop();
      if (!captured || !consultationId || !apiClient) {
        setStatus('idle');
        return null;
      }

      setStatus('uploading');
      const ext = fileExtensionFor(captured.mimeType);
      const [rawUpload, processedUpload] = await Promise.all([
        storage.uploadFile(STORAGE_BUCKET, new File([captured.raw], `raw-capture.${ext}`, { type: captured.mimeType })),
        storage.uploadFile(
          STORAGE_BUCKET,
          new File([captured.processed], processedFileName(captured.processedSource, ext), { type: captured.mimeType }),
        ),
      ]);

      // TASK-656 — mediaId is a Media table row UUID, not the raw storage key
      // (`.key`). The upload response's Media row creation is best-effort
      // server-side, so a missing mediaId is possible — surface it rather than
      // persisting an unresolvable reference.
      if (!rawUpload.mediaId || !processedUpload.mediaId) {
        throw new Error('Upload succeeded but no mediaId was returned');
      }
      const rawMediaId = rawUpload.mediaId;
      const processedMediaId = processedUpload.mediaId;

      await registerDualRecording(
        apiClient,
        consultationId,
        buildDualRecordingInput({ rawMediaId, processedMediaId, durationMs: captured.durationMs }),
      );

      const result: DualCapturePersistResult = {
        rawMediaId,
        processedMediaId,
        processedSource: captured.processedSource,
      };
      setLastResult(result);
      setProcessedSource(captured.processedSource);
      setStatus('saved');
      return result;
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to save dual-capture recording');
      return null;
    }
  }, [apiClient, consultationId, storage]);

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
    setLastResult(null);
    setProcessedSource(null);
  }, []);

  return {
    status,
    error,
    isCapturing: status === 'capturing',
    lastResult,
    processedSource,
    start,
    stopAndPersist,
    reset,
  };
}
