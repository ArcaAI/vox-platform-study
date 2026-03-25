import { recordSpeakerObservation, resolveSpeakerLabel } from '@/features/audio/lib/speaker-profiles';
import { upsertTranscriptEntry } from '@/features/audio/lib/transcript-state';
import type { TranscriptEntry } from '@/store/audio-store';
import {
    FileTranscriptionService,
    SSEClient,
    useAgenticStore,
    type TranscriptionJobResponse,
} from '@arcaai/vox';
import { useCallback, useEffect, useRef, useState } from 'react';

export type FileTranscriptionStatus =
    | 'idle'
    | 'uploading'
    | 'streaming'
    | 'complete'
    | 'error';

export interface FileUploadOptions {
    pipelineId: string;
    consultationId?: string;
    language?: string;
    sampleRate?: number;
    codeSwitching?: boolean;
    diarization?: boolean;
}

export interface UseFileTranscriptionReturn {
    status: FileTranscriptionStatus;
    isUploading: boolean;
    isStreaming: boolean;
    jobId: string | null;
    jobResponse: TranscriptionJobResponse | null;
    transcripts: TranscriptEntry[];
    error: string | null;
    uploadProgress: number;
    fileName: string | null;
    upload: (file: File, options: FileUploadOptions) => Promise<void>;
    reset: () => void;
    clearTranscripts: () => void;
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

    const sseClientRef = useRef<SSEClient | null>(null);
    const fileServiceRef = useRef<FileTranscriptionService | null>(null);
    const transcriptIdRef = useRef(0);
    const segmentCounterRef = useRef(0);

    const cleanupSSE = useCallback(() => {
        if (sseClientRef.current) {
            sseClientRef.current.disconnect();
            sseClientRef.current = null;
        }
    }, []);

    useEffect(() => {
        return () => {
            cleanupSSE();
            fileServiceRef.current?.dispose();
        };
    }, [cleanupSSE]);

    const upload = useCallback(
        async (file: File, options: FileUploadOptions) => {
            if (!apiClient) {
                throw new Error('SDK not initialized — no apiClient available');
            }

            try {
                setError(null);
                setStatus('uploading');
                setFileName(file.name);
                setUploadProgress(0);
                setTranscripts([]);
                transcriptIdRef.current = 0;
                segmentCounterRef.current = 0;

                const childLogger = logger?.child?.('FileTranscription') ?? logger;
                const fileService = new FileTranscriptionService(apiClient, childLogger);
                fileServiceRef.current = fileService;

                setUploadProgress(10);

                const job = await fileService.uploadAndTranscribe(file, {
                    pipelineId: options.pipelineId,
                    consultationId: options.consultationId,
                    language: options.language,
                    sampleRate: options.sampleRate,
                    codeSwitching: options.codeSwitching,
                    diarization: options.diarization,
                });

                setJobId(job.id);
                setJobResponse(job);
                setUploadProgress(100);
                setStatus('streaming');

                const sseClient = new SSEClient(childLogger);
                sseClientRef.current = sseClient;

                sseClient.onOpen(() => {
                    childLogger?.info?.('SSE stream connected', {
                        operation: 'sseConnect',
                        component: 'useFileTranscription',
                        attributes: { jobId: job.id },
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
                        const rawSpeakerId = (
                            payload.speakerId
                            ?? payload.speaker
                        ) as string | undefined;
                        const speakerId = rawSpeakerId?.trim() || undefined;
                        const speakerConfidence = asNumber(
                            payload.speakerConfidence,
                        );
                        const speakerEmbeddingRaw = payload.speakerEmbedding as unknown;
                        const speakerEmbedding = Array.isArray(speakerEmbeddingRaw)
                            ? speakerEmbeddingRaw.filter(
                                (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value),
                            )
                            : undefined;
                        const speakerFeatures = speakerEmbedding && speakerEmbedding.length > 0
                            ? { source: 'remote', vector: speakerEmbedding }
                            : undefined;

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
                        const speakerLabel = resolveSpeakerLabel(
                            speakerId,
                            (payload.speakerLabel ?? speakerProfile?.label) as string | undefined,
                        );

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

                // sseClient.onEvent('transcript', handleTranscriptData);
                sseClient.onEvent('chunk', handleTranscriptData);

                const handleComplete = () => {
                    setStatus('complete');
                    cleanupSSE();
                };

                sseClient.onEvent('complete', handleComplete);

                const handleStatusEvent = (data: string) => {
                    try {
                        const parsed = JSON.parse(data);
                        const status = parsed.data?.status ?? parsed.status;
                        if (status === 'COMPLETED') {
                            handleComplete();
                        } else if (status === 'FAILED') {
                            setError('Transcription job failed');
                            setStatus('error');
                            cleanupSSE();
                        }
                    } catch {
                        // ignore
                    }
                };
                sseClient.onEvent('status', handleStatusEvent);

                sseClient.onEvent('error', (data: string) => {
                    try {
                        const parsed = JSON.parse(data);
                        const payload = parsed.data ?? parsed;
                        setError(payload.message || 'Transcription job failed');
                    } catch {
                        setError('Transcription job failed');
                    }
                    setStatus('error');
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
                            const status = payload.status ?? eventType;
                            if (status === 'COMPLETED' || eventType === 'complete') {
                                handleComplete();
                            } else if (status === 'FAILED') {
                                setError('Transcription job failed');
                                setStatus('error');
                                cleanupSSE();
                            }
                        } else if (eventType === 'error') {
                            setError(payload.message || 'Transcription job failed');
                            setStatus('error');
                            cleanupSSE();
                        }
                    } catch {
                        // non-JSON message, ignore
                    }
                });

                sseClient.onError(() => {
                    // SSEClient handles reconnection internally
                });

                const streamUrl = fileService.buildJobStreamUrl(job.id);
                const token = apiClient.getAccessToken?.() || apiClient.getApiKey?.() || '';
                sseClient.connect(streamUrl, {
                    autoReconnect: true,
                    maxReconnectAttempts: 10,
                    authToken: token,
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : 'Failed to upload file';
                setError(msg);
                setStatus('error');
                throw err;
            }
        },
        [apiClient, logger, cleanupSSE],
    );

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
        jobId,
        jobResponse,
        transcripts,
        error,
        uploadProgress,
        fileName,
        upload,
        reset,
        clearTranscripts,
    };
}
