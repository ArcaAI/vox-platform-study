import { recordSpeakerObservation, resolveSpeakerLabel } from '@/features/audio/lib/speaker-profiles';
import { upsertTranscriptEntry } from '@/features/audio/lib/transcript-state';
import { createByteCounter, type ByteCounterHandle } from '@/lib/byte-counter';
import type { TranscriptEntry } from '@/store/audio-store';
import { usePlaygroundStore } from '@/store/playground-store';
import { createAudioCapture, float32ToInt16, type AudioCaptureHandle } from '@arcaai/stt';
import {
  StreamingSessionManager,
  SttV2WebSocketClient,
  useArcaStore,
  type AgenticClient,
  type ISDKLogger,
  type WsTranscriptResult,
} from '@arcaai/vox';
import { useCallback, useEffect, useRef, useState } from 'react';

export type RealtimeStatus = 'idle' | 'creating_session' | 'connecting' | 'streaming' | 'reconnecting' | 'stopping' | 'error';

type WebSocketErrorLike = {
  message: string;
  code: string | number;
};

function sanitizeTranscriptText(input: string): string {
  const trimmed = (input || '').trim();
  if (!trimmed) return '';

  const noChevronSpam = trimmed
    .replace(/(?:\s*>>\s*){4,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
  language?: string;
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
  /**
   * TASK-329 P4 / D-3: backend preseed echo for the active session. `true` when
   * the caller's enrolled voice profile was used to seed diarization, `false`
   * when diarization ran without personalization, and `null` before a session
   * is created (or when an older API revision omits the field).
   */
  voiceProfileSeeded: boolean | null;
  transcripts: TranscriptEntry[];
  error: string | null;
  /**
   * TASK-351 P0-6 (H7) — subscribable byte counter. Lives outside React
   * state so 250ms streaming commits no longer re-render the transcript
   * subtree; render it with `<LiveByteCount handle={bytesSent} />`.
   */
  bytesSent: ByteCounterHandle;
  reconnectAttempts: number;
  inputStream: MediaStream | null;
  start: (options: RealtimeStartOptions) => Promise<void>;
  stop: () => Promise<void>;
  clearTranscripts: () => void;
}

export function useRealtimeTranscription(): UseRealtimeTranscriptionReturn {
  const apiClient = useArcaStore((s: { apiClient: AgenticClient | null }) => s.apiClient);
  const logger = useArcaStore((s: { logger: ISDKLogger | null }) => s.logger);
  const debugMode = usePlaygroundStore((s) => s.debugMode);

  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [voiceProfileSeeded, setVoiceProfileSeeded] = useState<boolean | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  // TASK-351 P0-6 — bytes counter as an external store (no re-renders here).
  const byteCounterRef = useRef(createByteCounter());

  const sessionManagerRef = useRef<StreamingSessionManager | null>(null);
  const wsClientRef = useRef<SttV2WebSocketClient | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const ownsMediaStreamRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  // TASK-351 P0-5 — capture runs through @arcaai/stt's AudioWorklet utility
  // (coalesced ~80ms frames off the main thread; ScriptProcessor only as the
  // utility's internal fallback).
  const captureHandleRef = useRef<AudioCaptureHandle | null>(null);
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
    if (captureHandleRef.current) {
      captureHandleRef.current.destroy();
      captureHandleRef.current = null;
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
        setVoiceProfileSeeded(null);
        setStatus('creating_session');

        // TASK-321 — SDK ctors take `logger?: ISDKLogger` (undefined, not null).
        const childLogger = logger?.child?.('RealtimeTranscription') ?? logger ?? undefined;
        const sessionManager = new StreamingSessionManager(apiClient, childLogger);
        sessionManagerRef.current = sessionManager;

        // TASK-351 C5 — the negotiated sampleRate is part of the session
        // contract; the gateway tags every forwarded frame with it.
        const sampleRate = options.sampleRate ?? 16000;

        const sessionResponse = await sessionManager.createSession({
          pipelineId: options.pipelineId,
          consultationId: options.consultationId,
          microphoneId: options.microphoneId,
          language: options.language,
          sampleRate,
        });

        setSessionId(sessionResponse.sessionId);
        setVoiceProfileSeeded(sessionResponse.voiceProfileSeeded ?? null);
        setStatus('connecting');

        const token = apiClient.getAccessToken?.() || apiClient.getApiKey?.() || '';
        const wsUrl = sessionManager.getWebSocketUrl(token);
        if (!wsUrl) {
          throw new Error('Failed to build WebSocket URL');
        }

        const wsClient = new SttV2WebSocketClient(
          childLogger,
          {
            enabled: true,
            maxAttempts: 5,
            baseDelayMs: 1000,
            maxDelayMs: 15000,
          },
          debugMode,
        );
        wsClientRef.current = wsClient;

        wsClient.onTranscript((result: WsTranscriptResult) => {
          // TASK-351 P1-1 follow-up — gloss results never create a row:
          // attach the English translation to the entry that carries the
          // same utteranceIndex, or drop the gloss silently.
          if (result.resultType === 'gloss') {
            const glossText = typeof result.englishText === 'string' ? result.englishText.trim() : '';
            const glossIndex =
              typeof result.utteranceIndex === 'number' && Number.isFinite(result.utteranceIndex) ? result.utteranceIndex : undefined;
            if (!glossText || glossIndex == null) {
              return;
            }
            setTranscripts((prev) => {
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i]!.utteranceIndex === glossIndex) {
                  const next = [...prev];
                  next[i] = { ...next[i]!, englishText: glossText };
                  return next;
                }
              }
              return prev;
            });
            return;
          }

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
          const speakerConfidence =
            typeof result.speakerConfidence === 'number' && Number.isFinite(result.speakerConfidence) ? result.speakerConfidence : undefined;
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
            result.isFinal && result.wordTimestamps && result.wordTimestamps.length > 0 ? result.wordTimestamps : undefined;
          const inferenceTime = typeof result.inference === 'number' && Number.isFinite(result.inference) ? result.inference : 0;
          // TASK-351 P1-1 — committed-prefix length on partials (additive).
          const stableChars =
            !result.isFinal && typeof result.stableChars === 'number' && Number.isFinite(result.stableChars) && result.stableChars >= 0
              ? Math.min(result.stableChars, sanitizedText.length)
              : undefined;
          // TASK-351 P1-1 follow-up — utterance ordinal, kept on the entry so
          // a later gloss can find its segment.
          const utteranceIndex =
            typeof result.utteranceIndex === 'number' && Number.isFinite(result.utteranceIndex) ? result.utteranceIndex : undefined;
          const entry: TranscriptEntry = {
            id: `ws-${transcriptIdRef.current}`,
            segment: segmentCounterRef.current,
            text: sanitizedText,
            timestamp: Date.now(),
            isFinal: result.isFinal,
            stableChars,
            utteranceIndex,
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
                lastFinal &&
                lastFinal.text === entry.text &&
                Math.abs(lastFinal.start - entry.start) < 0.001 &&
                Math.abs(lastFinal.end - entry.end) < 0.001
              ) {
                const shouldUpgradeSpeaker =
                  Boolean(entry.speaker) &&
                  (!lastFinal.speaker ||
                    !lastFinal.speakerLabel ||
                    (typeof entry.speakerConfidence === 'number' &&
                      (typeof lastFinal.speakerConfidence !== 'number' || entry.speakerConfidence > lastFinal.speakerConfidence)));
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
        byteCounterRef.current.reset();

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

        const [audioTrack] = stream.getAudioTracks();
        if (!audioTrack) {
          throw new Error('Input stream has no audio track');
        }

        const audioContext = new AudioContext({ sampleRate });
        audioContextRef.current = audioContext;

        // TASK-351 P0-5 — SDK worklet capture: coalesced ~80ms Float32 frames
        // off the main thread; the Int16 view is sent zero-copy.
        captureHandleRef.current = await createAudioCapture(audioContext, audioTrack, (frame) => {
          if (!wsClient.isConnected()) return;

          const pcm16 = float32ToInt16(frame);
          wsClient.sendAudioFrame(pcm16);
          seqRef.current += 1;
          pendingBytesRef.current += pcm16.byteLength;
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          if (now - bytesCommitAtRef.current >= 250) {
            const delta = pendingBytesRef.current;
            pendingBytesRef.current = 0;
            bytesCommitAtRef.current = now;
            byteCounterRef.current.add(delta);
          }
        });
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
    setVoiceProfileSeeded(null);
    setStatus('idle');
    byteCounterRef.current.reset();
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
    voiceProfileSeeded,
    transcripts,
    error,
    bytesSent: byteCounterRef.current.handle,
    reconnectAttempts,
    inputStream: mediaStreamRef.current,
    start,
    stop,
    clearTranscripts,
  };
}
