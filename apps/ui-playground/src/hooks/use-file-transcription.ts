import { recordSpeakerObservation, resolveSpeakerLabel } from '@/features/audio/lib/speaker-profiles';
import { upsertTranscriptEntry } from '@/features/audio/lib/transcript-state';
import type { TranscriptEntry } from '@/store/audio-store';
import { FileTranscriptionService, SSEClient, useAgenticStore, type TranscriptionJobResponse } from '@arcaai/vox';
import type { ISDKLogger } from '@arcaai/vox';
import { useCallback, useEffect, useRef, useState } from 'react';

const BATCH_JOB_STORAGE_KEY = 'hope:batch-job';

function saveBatchJob(jobId: string, fileName: string): void {
  try {
    localStorage.setItem(BATCH_JOB_STORAGE_KEY, JSON.stringify({ jobId, fileName }));
  } catch {
    /* storage unavailable */
  }
}

function loadBatchJob(): { jobId: string; fileName: string } | null {
  try {
    const raw = localStorage.getItem(BATCH_JOB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.jobId === 'string' && typeof parsed?.fileName === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

function clearBatchJob(): void {
  try {
    localStorage.removeItem(BATCH_JOB_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export type FileTranscriptionStatus = 'idle' | 'uploading' | 'streaming' | 'complete' | 'error';

export interface FileUploadOptions {
  pipelineId: string;
  consultationId?: string;
  language?: string;
}

export interface UseFileTranscriptionReturn {
  status: FileTranscriptionStatus;
  isUploading: boolean;
  isStreaming: boolean;
  isReconnecting: boolean;
  jobId: string | null;
  jobResponse: TranscriptionJobResponse | null;
  transcripts: TranscriptEntry[];
  error: string | null;
  uploadProgress: number;
  fileName: string | null;
  upload: (file: File, options: FileUploadOptions) => Promise<void>;
  reset: () => void;
  clearTranscripts: () => void;
  cancel: () => void;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function useFileTranscription(): UseFileTranscriptionReturn {
  const apiClient = useAgenticStore((s) => s.apiClient);
  const logger = useAgenticStore((s) => s.logger);

  const [status, setStatus] = useState<FileTranscriptionStatus>('idle');
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobResponse, setJobResponse] = useState<TranscriptionJobResponse | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);

  const sseClientRef = useRef<SSEClient | null>(null);
  const fileServiceRef = useRef<FileTranscriptionService | null>(null);
  const transcriptIdRef = useRef(0);
  const segmentCounterRef = useRef(0);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const reconnectedRef = useRef(false);

  const cleanupSSE = useCallback(() => {
    if (sseClientRef.current) {
      sseClientRef.current.disconnect();
      sseClientRef.current = null;
    }
  }, []);

  const connectToJobSSE = useCallback(
    (targetJobId: string, fileService: FileTranscriptionService, childLogger: ISDKLogger | undefined) => {
      const sseClient = new SSEClient(childLogger);
      sseClientRef.current = sseClient;

      sseClient.onOpen(() => {
        childLogger?.info?.('SSE stream connected', {
          operation: 'sseConnect',
          component: 'useFileTranscription',
          attributes: { jobId: targetJobId },
        });
      });

      const handleTranscriptData = (data: string) => {
        try {
          const parsed = JSON.parse(data);
          const payload = parsed.data ?? parsed;
          const text = typeof payload.text === 'string' ? payload.text.trim() : '';
          if (!text) return;

          const isFinal = payload.isFinal ?? true;
          if (isFinal) {
            segmentCounterRef.current += 1;
          }
          const segment = isFinal ? segmentCounterRef.current : segmentCounterRef.current + 1;

          const start = asNumber(payload.startTime) ?? 0;
          const end = asNumber(payload.endTime) ?? start;
          const rawSpeakerId = (payload.speakerId ?? payload.speaker) as string | undefined;
          const speakerId = rawSpeakerId?.trim() || undefined;
          const speakerConfidence = asNumber(payload.speakerConfidence);
          const speakerEmbeddingRaw = payload.speakerEmbedding as unknown;
          const speakerEmbedding = Array.isArray(speakerEmbeddingRaw)
            ? speakerEmbeddingRaw.filter((value: unknown): value is number => typeof value === 'number' && Number.isFinite(value))
            : undefined;
          const speakerFeatures = speakerEmbedding && speakerEmbedding.length > 0 ? { source: 'remote', vector: speakerEmbedding } : undefined;

          const speakerProfile = speakerId
            ? recordSpeakerObservation({
                route: 'job',
                speakerId,
                speakerLabel: payload.speakerLabel,
                speakerConfidence,
                startTime: start,
                endTime: end,
                text,
                features: speakerFeatures,
              })
            : null;
          const speakerLabel = resolveSpeakerLabel(speakerId, (payload.speakerLabel ?? speakerProfile?.label) as string | undefined);

          transcriptIdRef.current += 1;
          const entry: TranscriptEntry = {
            id: `sse-${transcriptIdRef.current}`,
            segment,
            text,
            timestamp: Date.now(),
            isFinal,
            speaker: speakerId,
            speakerLabel,
            speakerConfidence,
            speakerFeatures,
            start: isFinal ? start : 0,
            end: isFinal ? end : 0,
            duration: isFinal ? Math.max(0, end - start) : 0,
            inference: 0,
          };
          setTranscripts((prev) => upsertTranscriptEntry(prev, entry));
        } catch {
          childLogger?.warn?.('Failed to parse SSE transcript event', {
            operation: 'sseTranscript',
            component: 'useFileTranscription',
          });
        }
      };

      sseClient.onEvent('chunk', handleTranscriptData);

      const handleComplete = () => {
        setStatus('complete');
        clearBatchJob();
        cleanupSSE();
      };

      sseClient.onEvent('complete', handleComplete);

      const handleStatusEvent = (data: string) => {
        try {
          const parsed = JSON.parse(data);
          const st = parsed.data?.status ?? parsed.status;
          if (st === 'COMPLETED') {
            handleComplete();
          } else if (st === 'FAILED') {
            setError('Transcription job failed');
            setStatus('error');
            clearBatchJob();
            cleanupSSE();
          }
        } catch {
          // ignore
        }
      };
      sseClient.onEvent('status', handleStatusEvent);

      sseClient.onEvent('error', (data: string) => {
        if (!data) return;
        try {
          const parsed = JSON.parse(data);
          const payload = parsed.data ?? parsed;
          setError(payload.message || 'Transcription job failed');
        } catch {
          setError('Transcription job failed');
        }
        setStatus('error');
        clearBatchJob();
        cleanupSSE();
      });

      sseClient.onMessage((data: string) => {
        try {
          const parsed = JSON.parse(data);
          const eventType = parsed.type;
          const payload = parsed.data ?? parsed;

          if (eventType === 'chunk' && payload.text) {
            handleTranscriptData(data);
          } else if (eventType === 'complete' || eventType === 'status') {
            const st = payload.status ?? eventType;
            if (st === 'COMPLETED' || eventType === 'complete') {
              handleComplete();
            } else if (st === 'FAILED') {
              setError('Transcription job failed');
              setStatus('error');
              clearBatchJob();
              cleanupSSE();
            }
          } else if (eventType === 'error') {
            setError(payload.message || 'Transcription job failed');
            setStatus('error');
            clearBatchJob();
            cleanupSSE();
          }
        } catch {
          // non-JSON message, ignore
        }
      });

      sseClient.onError(() => {
        // SSEClient handles reconnection internally
      });

      const streamUrl = fileService.buildJobStreamUrl(targetJobId);
      const token = apiClient?.getAccessToken?.() || apiClient?.getApiKey?.() || '';
      sseClient.connect(streamUrl, {
        autoReconnect: true,
        maxReconnectAttempts: 10,
        authToken: token,
      });
    },
    [apiClient, cleanupSSE],
  );

  useEffect(() => {
    return () => {
      cleanupSSE();
      fileServiceRef.current?.dispose();
      reconnectedRef.current = false;
    };
  }, [cleanupSSE]);

  const upload = useCallback(
    async (file: File, options: FileUploadOptions) => {
      if (!apiClient) {
        throw new Error('SDK not initialized - no apiClient available');
      }
      if (isReconnecting) return;

      try {
        setError(null);
        setStatus('uploading');
        setFileName(file.name);
        setUploadProgress(0);
        setTranscripts([]);
        transcriptIdRef.current = 0;
        segmentCounterRef.current = 0;

        const baseLogger: ISDKLogger | undefined = logger ?? undefined;
        const childLogger = baseLogger?.child('FileTranscription') ?? baseLogger;
        const fileService = new FileTranscriptionService(apiClient, childLogger);
        fileServiceRef.current = fileService;

        const abortController = new AbortController();
        uploadAbortRef.current = abortController;

        const job = await fileService.uploadAndTranscribeWithProgress(file, {
          pipelineId: options.pipelineId,
          consultationId: options.consultationId,
          language: options.language,
          signal: abortController.signal,
          onProgress: (progress) => setUploadProgress(Math.round(progress)),
        });

        uploadAbortRef.current = null;
        setJobId(job.id);
        setJobResponse(job);
        setUploadProgress(100);
        setStatus('streaming');
        saveBatchJob(job.id, file.name);

        connectToJobSSE(job.id, fileService, childLogger);
      } catch (err) {
        uploadAbortRef.current = null;
        if (err instanceof Error && err.message === 'Request aborted') {
          setStatus('idle');
          setUploadProgress(0);
          return;
        }
        const msg = err instanceof Error ? err.message : 'Failed to upload file';
        setError(msg);
        setStatus('error');
        clearBatchJob();
        throw err;
      }
    },
    [apiClient, logger, connectToJobSSE, isReconnecting],
  );

  const cancel = useCallback(() => {
    if (status === 'uploading') {
      uploadAbortRef.current?.abort();
      uploadAbortRef.current = null;
      setStatus('idle');
      setUploadProgress(0);
      clearBatchJob();
    } else if (status === 'streaming') {
      if (jobId) {
        fileServiceRef.current?.cancelJob(jobId).catch(() => {});
      }
      cleanupSSE();
      setStatus('idle');
      clearBatchJob();
    }
  }, [status, jobId, cleanupSSE]);

  const reconnect = useCallback(async () => {
    const saved = loadBatchJob();
    if (!saved || !apiClient) return;

    setIsReconnecting(true);
    const baseLogger: ISDKLogger | undefined = logger ?? undefined;
    const childLogger = baseLogger?.child('FileTranscription') ?? baseLogger;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const fileService = new FileTranscriptionService(apiClient, childLogger);
        fileServiceRef.current = fileService;

        const job = await fileService.getJob(saved.jobId);

        if (job.status === 'PROCESSING' || job.status === 'QUEUED') {
          setJobId(job.id);
          setJobResponse(job);
          setFileName(saved.fileName);
          setStatus('streaming');
          connectToJobSSE(job.id, fileService, childLogger);
        } else if (job.status === 'COMPLETED') {
          setJobId(job.id);
          setJobResponse(job);
          setFileName(saved.fileName);
          setStatus('complete');
          clearBatchJob();
          if (job.resultText) {
            transcriptIdRef.current += 1;
            const entry: TranscriptEntry = {
              id: `restored-${transcriptIdRef.current}`,
              segment: 1,
              text: job.resultText,
              timestamp: Date.now(),
              isFinal: true,
              start: 0,
              end: 0,
              duration: 0,
              inference: 0,
            };
            setTranscripts([entry]);
          }
        } else {
          clearBatchJob();
        }
        setIsReconnecting(false);
        return;
      } catch (err) {
        const is404 = err instanceof Error && (err.message.includes('404') || err.message.includes('not found') || err.message.includes('NOT_FOUND'));
        if (is404) {
          childLogger?.warn?.('Reconnect: job not found, clearing saved job', {
            operation: 'reconnect',
            component: 'useFileTranscription',
            attributes: { jobId: saved.jobId, attempt },
          });
          clearBatchJob();
          setIsReconnecting(false);
          return;
        }
        childLogger?.warn?.('Reconnect attempt failed, retrying', {
          operation: 'reconnect',
          component: 'useFileTranscription',
          attributes: { jobId: saved.jobId, attempt, maxRetries },
          error: err as Error,
        });
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }
    childLogger?.error?.('Reconnect failed after all retries', {
      operation: 'reconnect',
      component: 'useFileTranscription',
      attributes: { jobId: saved.jobId, maxRetries },
    });
    setIsReconnecting(false);
  }, [apiClient, logger, connectToJobSSE]);

  useEffect(() => {
    if (!apiClient || reconnectedRef.current) return;
    reconnectedRef.current = true;
    reconnect();
  }, [apiClient, reconnect]);

  const reset = useCallback(() => {
    cleanupSSE();
    fileServiceRef.current?.dispose();
    fileServiceRef.current = null;
    setStatus('idle');
    setJobId(null);
    setJobResponse(null);
    setTranscripts([]);
    setError(null);
    setUploadProgress(0);
    setFileName(null);
    transcriptIdRef.current = 0;
    segmentCounterRef.current = 0;
    clearBatchJob();
  }, [cleanupSSE]);

  const clearTranscripts = useCallback(() => {
    setTranscripts([]);
    transcriptIdRef.current = 0;
    segmentCounterRef.current = 0;
  }, []);

  return {
    status,
    isUploading: status === 'uploading',
    isStreaming: status === 'streaming',
    isReconnecting,
    jobId,
    jobResponse,
    transcripts,
    error,
    uploadProgress,
    fileName,
    upload,
    reset,
    clearTranscripts,
    cancel,
  };
}
