'use client';

/**
 * TASK-433 — live STT session state machine (frame 51 streaming tab).
 * Flow: mic capture grant → `POST stream/session` through the BFF → WS
 * DIRECTLY to the gateway (`publicEnv.apiHost`, one-shot ticket + tenant
 * claim in the URL) → Int16 PCM frames from the `@arcaai/stt` worklet →
 * stop sends `{type:'stop'}`, tears down and DELETEs the session.
 *
 * Reference wiring: the deprecated ui-playground `use-realtime-transcription`
 * (API usage only — auth here is the console BFF, never sessionStorage).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioCapture, float32ToInt16, type AudioCaptureHandle } from '@arcaai/stt';
import { SttV2WebSocketClient } from '@arcaai/vox/core';
import { publicEnv } from '@/config/public-env';
import { GatewayError } from '@/shared/api';
import { buildStreamWsUrl, closeStreamSession, createStreamSession, refreshStreamTicket } from './client';
import type { WsErrorPayload, WsTranscriptPayload } from './types';

export type LiveSttStatus = 'idle' | 'requesting_mic' | 'creating_session' | 'connecting' | 'streaming' | 'reconnecting' | 'stopping' | 'error';

export type MicPermission = 'unknown' | 'granted' | 'denied';

export interface LiveTranscriptRow {
    id: number;
    text: string;
    isFinal: boolean;
    /** Wall-clock receive time (epoch ms) — the row's timestamp column. */
    receivedAt: number;
    /** Backend inference time in ms (frame 51 latency meta), when reported. */
    latencyMs: number | null;
    seq: number | null;
    speakerLabel?: string;
}

export interface LiveSessionMeta {
    sessionId: string;
    voiceProfileSeeded: boolean;
    currentActive: number;
    maxConcurrent: number;
    /** Epoch ms expiry of the CURRENT ticket (refreshed on reconnect). */
    ticketExpiresAt: number;
    startedAt: number;
}

/**
 * Generic close copy — ALL WS handshake failures collapse to 4401 on the
 * gateway (no session/ticket enumeration), so the client copy never gets
 * more specific than this (matrix row 35 verification note 4).
 */
const GENERIC_AUTH_COPY = 'Live session expired or unauthorized — reconnect mints a fresh ticket; if it keeps failing, start a new session.';

const SAMPLE_RATE = 16_000;

/** Level-meter commit throttle so 80 ms frames do not re-render the tree. */
const LEVEL_COMMIT_MS = 200;

/**
 * Structural view of `SttV2WebSocketClient` — @arcaai/vox ships `dts: false`,
 * so the constructed instance is typed locally against the methods this hook
 * uses (and tests fake).
 */
interface SttStreamClient {
    connect(url: string): Promise<void>;
    disconnect(): void;
    isConnected(): boolean;
    sendAudioFrame(data: ArrayBuffer | ArrayBufferView): boolean;
    sendStop(): void;
    onTranscript(cb: (result: WsTranscriptPayload) => void): void;
    onWsError(cb: (error: WsErrorPayload) => void): void;
    onDisconnect(cb: () => void): void;
    onReconnect(cb: (attempt: number) => void): void;
    onReconnectFailed(cb: () => void): void;
    /** Optional in this structural view so partial test fakes need not stub it; the real client always implements it. */
    onBackpressureDrop?(cb: (reason: 'queue_full' | 'buffered_amount_high') => void): void;
}

export interface StartLiveSttOptions {
    pipelineId: string;
    /** `workingTenantId ?? session.user.tenantId` — REQUIRED for the WS tenant-claim guard. */
    tenantId: string;
    language?: string;
}

export interface UseLiveSttSessionResult {
    status: LiveSttStatus;
    /** Failure copy for the error panel (4401 stays generic). */
    error: string | null;
    /** True when session create hit the tenant concurrency quota (429). */
    quotaExceeded: boolean;
    micPermission: MicPermission;
    micLabel: string | null;
    session: LiveSessionMeta | null;
    finals: LiveTranscriptRow[];
    partial: LiveTranscriptRow | null;
    lastSeq: number | null;
    lastLatencyMs: number | null;
    /** 0-100 input level for the meter. */
    level: number;
    reconnectAttempt: number;
    /** Frames the client dropped at its backpressure watermark since the session (or last reconnect) started. */
    droppedFrameCount: number;
    /** True once outbound audio has been dropped — the durable transcript is missing data (C6-01). */
    connectionDegraded: boolean;
    start: (options: StartLiveSttOptions) => Promise<void>;
    stop: () => Promise<void>;
}

export function useLiveSttSession(): UseLiveSttSessionResult {
    const [status, setStatus] = useState<LiveSttStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    const [quotaExceeded, setQuotaExceeded] = useState(false);
    const [micPermission, setMicPermission] = useState<MicPermission>('unknown');
    const [micLabel, setMicLabel] = useState<string | null>(null);
    const [session, setSession] = useState<LiveSessionMeta | null>(null);
    const [finals, setFinals] = useState<LiveTranscriptRow[]>([]);
    const [partial, setPartial] = useState<LiveTranscriptRow | null>(null);
    const [lastSeq, setLastSeq] = useState<number | null>(null);
    const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
    const [level, setLevel] = useState(0);
    const [reconnectAttempt, setReconnectAttempt] = useState(0);
    const [droppedFrameCount, setDroppedFrameCount] = useState(0);
    const [connectionDegraded, setConnectionDegraded] = useState(false);

    const statusRef = useRef<LiveSttStatus>('idle');
    useEffect(() => {
        statusRef.current = status;
    }, [status]);

    const wsClientRef = useRef<SttStreamClient | null>(null);
    const captureRef = useRef<AudioCaptureHandle | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const sessionIdRef = useRef<string | null>(null);
    const rowIdRef = useRef(0);
    const levelCommitAtRef = useRef(0);

    const releaseAudio = useCallback(() => {
        captureRef.current?.destroy();
        captureRef.current = null;
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            void audioContextRef.current.close().catch(() => {});
        }
        audioContextRef.current = null;
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        setLevel(0);
    }, []);

    // Unmount teardown: capture, socket, then a best-effort session DELETE so
    // the gateway slot frees without waiting for the socket-registry timeout.
    useEffect(() => {
        return () => {
            captureRef.current?.destroy();
            if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
                void audioContextRef.current.close().catch(() => {});
            }
            mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
            wsClientRef.current?.disconnect();
            if (sessionIdRef.current) {
                void closeStreamSession(sessionIdRef.current).catch(() => {});
            }
        };
    }, []);

    const handleTranscript = useCallback((result: WsTranscriptPayload) => {
        // Gloss results are follow-up translations — they never create a row.
        if (result.resultType === 'gloss') return;
        const text = (result.text ?? '').trim();
        if (!text) return;

        const latencyMs = typeof result.inference === 'number' && Number.isFinite(result.inference) ? Math.round(result.inference * 1000) : null;
        if (typeof result.seq === 'number') setLastSeq(result.seq);
        if (latencyMs !== null) setLastLatencyMs(latencyMs);

        rowIdRef.current += 1;
        const row: LiveTranscriptRow = {
            id: rowIdRef.current,
            text,
            isFinal: result.isFinal,
            receivedAt: Date.now(),
            latencyMs,
            seq: typeof result.seq === 'number' ? result.seq : null,
            speakerLabel: result.speakerLabel,
        };

        if (result.isFinal) {
            setFinals((previous) => [...previous, row]);
            setPartial(null);
        } else {
            // Partials replace in place — one live row until a final commits.
            setPartial(row);
        }
    }, []);

    const start = useCallback(
        async (options: StartLiveSttOptions) => {
            if (statusRef.current !== 'idle' && statusRef.current !== 'error') return;

            setError(null);
            setQuotaExceeded(false);
            setFinals([]);
            setPartial(null);
            setLastSeq(null);
            setLastLatencyMs(null);
            setReconnectAttempt(0);
            setDroppedFrameCount(0);
            setConnectionDegraded(false);
            rowIdRef.current = 0;

            // 1. Microphone first — a denied prompt must not burn a session
            //    (the one-shot ticket only lives ~30 s once minted).
            setStatus('requesting_mic');
            let stream: MediaStream;
            try {
                if (!navigator.mediaDevices?.getUserMedia) {
                    throw new Error('Microphone capture requires a secure context (getUserMedia unavailable).');
                }
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: { sampleRate: SAMPLE_RATE, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                });
            } catch (micError) {
                const name = micError instanceof DOMException ? micError.name : '';
                if (name === 'NotAllowedError' || name === 'SecurityError') setMicPermission('denied');
                setError(micError instanceof Error ? micError.message : 'Microphone access failed.');
                setStatus('error');
                return;
            }
            mediaStreamRef.current = stream;
            const [track] = stream.getAudioTracks();
            if (!track) {
                releaseAudio();
                setError('The input stream has no audio track.');
                setStatus('error');
                return;
            }
            setMicPermission('granted');
            setMicLabel(track.label || 'Default microphone');

            // 2. Session create through the BFF (429 = designed quota panel).
            setStatus('creating_session');
            let created;
            try {
                created = await createStreamSession({ pipelineId: options.pipelineId, sampleRate: SAMPLE_RATE, language: options.language });
            } catch (createError) {
                releaseAudio();
                if (createError instanceof GatewayError && createError.status === 429) {
                    setQuotaExceeded(true);
                    setError(createError.message);
                } else {
                    setError(createError instanceof Error ? createError.message : 'Could not create the streaming session.');
                }
                setStatus('error');
                return;
            }
            sessionIdRef.current = created.sessionId;
            setSession({
                sessionId: created.sessionId,
                voiceProfileSeeded: created.voiceProfileSeeded ?? false,
                currentActive: created.currentActive,
                maxConcurrent: created.maxConcurrent,
                ticketExpiresAt: created.ticketExpiresAt,
                startedAt: Date.now(),
            });

            // 3. WS direct to the gateway. Reconnects mint a FRESH one-shot
            //    ticket through the BFF refresh route (TASK-298 D-18).
            setStatus('connecting');
            const client = new SttV2WebSocketClient(
                undefined,
                {
                    enabled: true,
                    maxAttempts: 5,
                    baseDelayMs: 1_000,
                    maxDelayMs: 15_000,
                    refreshTicket: async () => {
                        const refreshed = await refreshStreamTicket(created.sessionId);
                        setSession((previous) => (previous ? { ...previous, ticketExpiresAt: refreshed.ticketExpiresAt } : previous));
                        return refreshed.ticket;
                    },
                },
                false,
            ) as unknown as SttStreamClient;
            wsClientRef.current = client;

            client.onTranscript(handleTranscript);
            client.onWsError((wsError) => {
                setError(`${wsError.message} (${wsError.code})`);
            });
            client.onDisconnect(() => {
                // Reconnect (enabled above) picks the session back up; stop()
                // and unmount disconnect intentionally.
                if (statusRef.current !== 'stopping' && statusRef.current !== 'idle') {
                    setStatus('reconnecting');
                }
            });
            client.onReconnect((attempt) => {
                setReconnectAttempt(attempt);
                // A fresh (empty) send buffer clears the backpressure degradation.
                setDroppedFrameCount(0);
                setConnectionDegraded(false);
                setStatus('reconnecting');
            });
            client.onReconnectFailed(() => {
                setError(GENERIC_AUTH_COPY);
                setStatus('error');
            });
            // C6-01 — the client silently drops outbound audio above its 1 MiB
            // bufferedAmount watermark. Surface it so the clinician sees the
            // durable transcript is losing data, not just a cosmetic hiccup.
            client.onBackpressureDrop?.(() => {
                setDroppedFrameCount((count) => count + 1);
                setConnectionDegraded(true);
            });

            const wsUrl = buildStreamWsUrl(publicEnv.apiHost, created.wsUrl || '/ws/stt-v2/stream', {
                sessionId: created.sessionId,
                ticket: created.ticket,
                tenantId: options.tenantId,
            });

            try {
                await client.connect(wsUrl);
            } catch {
                // Handshake failures close 4401 with no cause — copy stays generic.
                wsClientRef.current = null;
                releaseAudio();
                void closeStreamSession(created.sessionId).catch(() => {});
                sessionIdRef.current = null;
                setSession(null);
                setError(GENERIC_AUTH_COPY);
                setStatus('error');
                return;
            }

            // 4. Worklet capture — coalesced Float32 frames, sent as Int16 PCM.
            try {
                const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
                audioContextRef.current = audioContext;
                captureRef.current = await createAudioCapture(audioContext, track, (frame) => {
                    if (!client.isConnected()) return;
                    client.sendAudioFrame(float32ToInt16(frame));

                    const now = Date.now();
                    if (now - levelCommitAtRef.current >= LEVEL_COMMIT_MS) {
                        levelCommitAtRef.current = now;
                        let sum = 0;
                        for (const sample of frame) sum += sample * sample;
                        const rms = Math.sqrt(sum / (frame.length || 1));
                        setLevel(Math.min(100, Math.round(rms * 300)));
                    }
                });
            } catch (captureError) {
                releaseAudio();
                client.disconnect();
                wsClientRef.current = null;
                void closeStreamSession(created.sessionId).catch(() => {});
                sessionIdRef.current = null;
                setSession(null);
                setError(captureError instanceof Error ? captureError.message : 'Audio capture failed to start.');
                setStatus('error');
                return;
            }

            setStatus('streaming');
        },
        [handleTranscript, releaseAudio],
    );

    const stop = useCallback(async () => {
        if (!wsClientRef.current && !sessionIdRef.current) return;
        setStatus('stopping');

        try {
            if (wsClientRef.current?.isConnected()) {
                wsClientRef.current.sendStop();
            }
        } catch {
            // best-effort finalize
        }

        releaseAudio();

        wsClientRef.current?.disconnect();
        wsClientRef.current = null;

        if (sessionIdRef.current) {
            await closeStreamSession(sessionIdRef.current).catch(() => {});
            sessionIdRef.current = null;
        }

        setSession(null);
        setReconnectAttempt(0);
        setDroppedFrameCount(0);
        setConnectionDegraded(false);
        // Transcript history stays on screen for review after the session ends.
        setStatus('idle');
    }, [releaseAudio]);

    return {
        status,
        error,
        quotaExceeded,
        micPermission,
        micLabel,
        session,
        finals,
        partial,
        lastSeq,
        lastLatencyMs,
        level,
        reconnectAttempt,
        droppedFrameCount,
        connectionDegraded,
        start,
        stop,
    };
}
