import { recordSpeakerObservation, resolveSpeakerLabel } from '@/features/audio/lib/speaker-profiles';
import { upsertTranscriptEntry } from '@/features/audio/lib/transcript-state';
import type { TranscriptEntry } from '@/store/audio-store';
import { usePlaygroundStore } from '@/store/playground-store';
import {
    StreamingSessionManager,
    SttV2WebSocketClient,
    useAgenticStore,
    type WsTranscriptResult,
} from '@arcaai/vox';
import { useCallback, useEffect, useRef, useState } from 'react';

export type RealtimeStatus =
    | 'idle'
    | 'creating_session'
    | 'connecting'
    | 'streaming'
    | 'reconnecting'
    | 'stopping'
    | 'error';

type ApiClientLike = {
    getAccessToken?: () => string | null | undefined;
    getApiKey?: () => string | null | undefined;
};

type LoggerLike = {
    child?: (name: string) => LoggerLike;
};

type WebSocketErrorLike = {
    message: string;
    code: string | number;
};

function sanitizeTranscriptText(input: string): string {
    const trimmed = (input || '').trim();
    if (!trimmed) return '';

    const noChevronSpam = trimmed.replace(/(?:\s*>>\s*){4,}/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return noChevronSpam;
}

function normalizeSpeakerFeatures(result: WsTranscriptResult): TranscriptEntry['speakerFeatures'] | undefined {
    if (Array.isArray(result.speakerEmbedding) && result.speakerEmbedding.length > 0) {
        return {
            source: 'remote',
            vector: result.speakerEmbedding,
        };
    }
    return undefined;
}

export interface RealtimeStartOptions {
    pipelineId: string;
    consultationId?: string;
    microphoneId?: string;
    sampleRate?: number;
    deviceId?: string;
    /** Pre-mixed MediaStream to use instead of calling getUserMedia */
    stream?: MediaStream;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
}

export interface UseRealtimeTranscriptionReturn {
    status: RealtimeStatus;
    isStreaming: boolean;
    sessionId: string | null;
    transcripts: TranscriptEntry[];
    error: string | null;
    bytesSent: number;
    reconnectAttempts: number;
    inputStream: MediaStream | null;
    start: (options: RealtimeStartOptions) => Promise<void>;
    stop: () => Promise<void>;
    clearTranscripts: () => void;
}

export function useRealtimeTranscription(): UseRealtimeTranscriptionReturn {
    const apiClient = useAgenticStore((s: { apiClient: ApiClientLike | null }) => s.apiClient);
    const logger = useAgenticStore((s: { logger: LoggerLike | null }) => s.logger);
    const debugMode = usePlaygroundStore((s) => s.debugMode);

    const [status, setStatus] = useState<RealtimeStatus>('idle');
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [bytesSent, setBytesSent] = useState(0);
    const [reconnectAttempts, setReconnectAttempts] = useState(0);

    const sessionManagerRef = useRef<StreamingSessionManager | null>(null);
    const wsClientRef = useRef<SttV2WebSocketClient | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const ownsMediaStreamRef = useRef(false);
    const audioContextRef = useRef<AudioContext | null>(null);
    const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const processorRef = useRef<ScriptProcessorNode | null>(null);
    const silentGainRef = useRef<GainNode | null>(null);
    const statusRef = useRef<RealtimeStatus>('idle');
    const seqRef = useRef(0);
    const transcriptIdRef = useRef(0);
    const segmentCounterRef = useRef(0);
    const pendingBytesRef = useRef(0);
    const bytesCommitAtRef = useRef(0);

    useEffect(() => {
        statusRef.current = status;
    }, [status]);

    const cleanupAudio = useCallback(() => {
        if (processorRef.current) {
            processorRef.current.disconnect();
            processorRef.current = null;
        }
        if (sourceNodeRef.current) {
            sourceNodeRef.current.disconnect();
            sourceNodeRef.current = null;
        }
        if (silentGainRef.current) {
            silentGainRef.current.disconnect();
            silentGainRef.current = null;
        }
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            audioContextRef.current.close().catch(() => {});
            audioContextRef.current = null;
        }
        if (mediaStreamRef.current && ownsMediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        }
        mediaStreamRef.current = null;
        ownsMediaStreamRef.current = false;
    }, []);

    useEffect(() => {
        return () => {
            cleanupAudio();
            wsClientRef.current?.disconnect();
            sessionManagerRef.current?.closeSession().catch(() => {});
        };
    }, [cleanupAudio]);

    const start = useCallback(
        async (options: RealtimeStartOptions) => {
            if (!apiClient) {
                throw new Error('SDK not initialized — no apiClient available');
            }

            try {
                setError(null);
                setStatus('creating_session');

                const childLogger = logger?.child?.('RealtimeTranscription') ?? logger;
                const sessionManager = new StreamingSessionManager(apiClient, childLogger);
                sessionManagerRef.current = sessionManager;

                const sessionResponse = await sessionManager.createSession({
                    pipelineId: options.pipelineId,
                    consultationId: options.consultationId,
                    microphoneId: options.microphoneId,
                });

                setSessionId(sessionResponse.sessionId);
                setStatus('connecting');

                const token = apiClient.getAccessToken?.() || apiClient.getApiKey?.() || '';
                const wsUrl = sessionManager.getWebSocketUrl(token);
                if (!wsUrl) {
                    throw new Error('Failed to build WebSocket URL');
                }

                const wsClient = new SttV2WebSocketClient(childLogger, {
                    enabled: true,
                    maxAttempts: 5,
                    baseDelayMs: 1000,
                    maxDelayMs: 15000,
                }, debugMode);
                wsClientRef.current = wsClient;

                wsClient.onTranscript((result: WsTranscriptResult) => {
                    const sanitizedText = sanitizeTranscriptText(result.text);
                    if (!sanitizedText) {
                        return;
                    }

                    transcriptIdRef.current += 1;
                    if (result.isFinal) {
                        segmentCounterRef.current += 1;
                    }
                    const startSec = parseFloat(Math.max(0, result.startTime ?? 0).toFixed(3));
                    const endSec = parseFloat(Math.max(0, result.endTime ?? 0).toFixed(3));
                    const speakerId = result.speakerId?.trim() || undefined;
                    const speakerConfidence = typeof result.speakerConfidence === 'number'
                        && Number.isFinite(result.speakerConfidence)
                        ? result.speakerConfidence
                        : undefined;
                    const speakerFeatures = normalizeSpeakerFeatures(result);
                    const speakerProfile = speakerId
                        ? recordSpeakerObservation({
                            route: 'live',
                            speakerId,
                            speakerLabel: result.speakerLabel,
                            speakerConfidence,
                            startTime: startSec,
                            endTime: endSec,
                            text: sanitizedText,
                            features: speakerFeatures,
                        })
                        : null;
                    const speakerLabel = resolveSpeakerLabel(speakerId, result.speakerLabel ?? speakerProfile?.label);
                    const wordTimestamps: TranscriptEntry['wordTimestamps'] =
                        result.isFinal && result.wordTimestamps && result.wordTimestamps.length > 0
                            ? result.wordTimestamps
                            : undefined;
                    const inferenceTime = typeof result.inference === 'number'
                        && Number.isFinite(result.inference)
                        ? result.inference
                        : 0;
                    const entry: TranscriptEntry = {
                        id: `ws-${transcriptIdRef.current}`,
                        segment: segmentCounterRef.current,
                        text: sanitizedText,
                        timestamp: Date.now(),
                        isFinal: result.isFinal,
                        speaker: speakerId,
                        speakerLabel,
                        speakerConfidence,
                        speakerFeatures,
                        start: result.isFinal ? startSec : 0,
                        end: result.isFinal ? endSec : 0,
                        duration: result.isFinal ? parseFloat((endSec - startSec).toFixed(3)) : 0,
                        inference: inferenceTime,
                        wordTimestamps,
                    };
                    setTranscripts((prev) => {
                        if (result.isFinal) {
                            const lastFinal = [...prev].reverse().find((t) => t.isFinal);
                            if (
                                lastFinal
                                && lastFinal.text === entry.text
                                && Math.abs(lastFinal.start - entry.start) < 0.001
                                && Math.abs(lastFinal.end - entry.end) < 0.001
                            ) {
                                const shouldUpgradeSpeaker = (
                                    Boolean(entry.speaker)
                                    && (
                                        !lastFinal.speaker
                                        || !lastFinal.speakerLabel
                                        || (
                                            typeof entry.speakerConfidence === 'number'
                                            && (
                                                typeof lastFinal.speakerConfidence !== 'number'
                                                || entry.speakerConfidence > lastFinal.speakerConfidence
                                            )
                                        )
                                    )
                                );
                                if (!shouldUpgradeSpeaker) {
                                    return prev;
                                }

                                const next = [...prev];
                                const targetIndex = next.findIndex((item) => item.id === lastFinal.id);
                                if (targetIndex === -1) {
                                    return prev;
                                }
                                next[targetIndex] = {
                                    ...next[targetIndex],
                                    speaker: entry.speaker,
                                    speakerLabel: entry.speakerLabel,
                                    speakerConfidence: entry.speakerConfidence,
                                    speakerFeatures: entry.speakerFeatures,
                                };
                                return next;
                            }
                        }

                        return upsertTranscriptEntry(prev, entry);
                    });
                });

                wsClient.onReconnect((attempt: number) => {
                    setReconnectAttempts(attempt);
                    setStatus('reconnecting');
                });

                wsClient.onReconnectFailed(() => {
                    setStatus('error');
                    setError('WebSocket reconnection failed — max attempts exhausted');
                });

                wsClient.onWsError((wsError: WebSocketErrorLike) => {
                    setError(`WebSocket error: ${wsError.message} (${wsError.code})`);
                });

                wsClient.onDisconnect(() => {
                    if (statusRef.current !== 'stopping') {
                        setStatus('error');
                    }
                });

                await wsClient.connect(wsUrl);
                setStatus('streaming');
                setReconnectAttempts(0);
                seqRef.current = 0;
                pendingBytesRef.current = 0;
                bytesCommitAtRef.current = 0;
                setBytesSent(0);

                const sampleRate = options.sampleRate ?? 16000;
                const hasDeviceId = options.deviceId != null && options.deviceId.trim().length > 0;
                const stream = options.stream
                    ? options.stream
                    : await navigator.mediaDevices.getUserMedia({
                        audio: hasDeviceId
                            ? {
                                deviceId: { exact: options.deviceId },
                                sampleRate,
                                echoCancellation: options.echoCancellation ?? true,
                                noiseSuppression: options.noiseSuppression ?? true,
                                autoGainControl: options.autoGainControl ?? true,
                            }
                            : {
                                sampleRate,
                                echoCancellation: options.echoCancellation ?? true,
                                noiseSuppression: options.noiseSuppression ?? true,
                                autoGainControl: options.autoGainControl ?? true,
                            },
                    });
                mediaStreamRef.current = stream;
                ownsMediaStreamRef.current = !options.stream;

                const audioContext = new AudioContext({ sampleRate });
                audioContextRef.current = audioContext;

                const source = audioContext.createMediaStreamSource(stream);
                sourceNodeRef.current = source;
                const processor = audioContext.createScriptProcessor(4096, 1, 1);
                processorRef.current = processor;
                const silentGain = audioContext.createGain();
                silentGain.gain.value = 0;
                silentGainRef.current = silentGain;

                processor.onaudioprocess = (event) => {
                    if (!wsClient.isConnected()) return;

                    const inputData = event.inputBuffer.getChannelData(0);
                    const pcm16 = new Int16Array(inputData.length);
                    for (let i = 0; i < inputData.length; i++) {
                        const s = Math.max(-1, Math.min(1, inputData[i]));
                        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
                    }

                    wsClient.sendAudioFrame(pcm16.buffer);
                    seqRef.current += 1;
                    pendingBytesRef.current += pcm16.byteLength;
                    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    if (now - bytesCommitAtRef.current >= 250) {
                        const delta = pendingBytesRef.current;
                        pendingBytesRef.current = 0;
                        bytesCommitAtRef.current = now;
                        setBytesSent((prev) => prev + delta);
                    }
                };

                source.connect(processor);
                processor.connect(silentGain);
                silentGain.connect(audioContext.destination);
            } catch (err) {
                const msg = err instanceof Error ? err.message : 'Failed to start streaming';
                setError(msg);
                setStatus('error');
                cleanupAudio();
                throw err;
            }
        },
        [apiClient, logger, cleanupAudio, debugMode],
    );

    const stop = useCallback(async () => {
        setStatus('stopping');

        try {
            if (wsClientRef.current?.isConnected()) {
                wsClientRef.current.sendStop();
            }
        } catch {
            // best-effort
        }

        cleanupAudio();

        wsClientRef.current?.disconnect();
        wsClientRef.current = null;

        if (sessionManagerRef.current) {
            await sessionManagerRef.current.closeSession().catch(() => {});
            sessionManagerRef.current = null;
        }

        setSessionId(null);
        setStatus('idle');
        setBytesSent(0);
        setReconnectAttempts(0);
    }, [cleanupAudio]);

    const clearTranscripts = useCallback(() => {
        setTranscripts([]);
        transcriptIdRef.current = 0;
        segmentCounterRef.current = 0;
    }, []);

    return {
        status,
        isStreaming: status === 'streaming',
        sessionId,
        transcripts,
        error,
        bytesSent,
        reconnectAttempts,
        inputStream: mediaStreamRef.current,
        start,
        stop,
        clearTranscripts,
    };
}
