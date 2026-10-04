'use client';

/**
 * The Studio Test tab's Record control (TASK-1036 §10.2, OD-15).
 *
 * Mic first (a refused prompt must not burn a session), then `POST …/stream/session` WITHOUT a
 * consultation — the sandbox run, started with `recording.sttSessionId`, creates the sandbox
 * consultation and binds the session to it (`WorkflowSandboxRunService.bindSandboxConsultation`) —
 * then the WS DIRECTLY to the gateway with the one-shot ticket and the tenant claim, then Int16
 * PCM frames at the 16 kHz the session declares. Stop drains the socket (the server finalises
 * after `stop`, so slamming it would lose the last utterance — TASK-985 M-05), closes the session
 * and releases the mic.
 *
 * Transcripts are NOT read off this socket: the gateway mirrors them into the run's admin trace
 * as `transcript.partial|final` (TASK-1036 B6b), which is the one place the Test tab reads them —
 * so what the panel shows is exactly what the run received.
 *
 * A trimmed sibling of the live-transcription playground's `useLiveSttSession` (a feature the
 * Studio may not import — rule 13). The browser runs no model: only the capture helpers of
 * `@arcaai/stt` are used (TASK-865).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioCapture, createStreamingResampler, float32ToInt16, type AudioCaptureHandle } from '@arcaai/stt';
import { SttWebSocketClient } from '@arcaai/vox/core';
import { publicEnv } from '@/config/public-env';
import { buildSttWsUrl, closeSttStreamSession, createSttStreamSession, refreshSttStreamTicket } from './client';

export type SandboxRecordingStatus = 'idle' | 'starting' | 'recording' | 'stopping' | 'error';

export interface StartSandboxRecordingOptions {
  /** The graph's speech-to-text agent; omitted ⇒ the gateway resolves the tenant default. */
  agentSlug?: string;
  /** Required by the WS tenant-claim guard. */
  tenantId: string;
  language?: string;
}

export interface SandboxRecording {
  status: SandboxRecordingStatus;
  error: string | null;
  sessionId: string | null;
  /** Recent input levels (0–100), newest last — the live waveform. */
  levels: number[];
  /** Resolves to the STT session id once audio is flowing, or `null` on failure. */
  start: (options: StartSandboxRecordingOptions) => Promise<string | null>;
  stop: () => Promise<void>;
}

const SAMPLE_RATE = 16_000;
const LEVEL_HISTORY = 32;
const LEVEL_COMMIT_MS = 120;

/** Structural view of `SttWebSocketClient` (`@arcaai/vox` ships no declarations). */
interface SttStreamClient {
  connect(url: string): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  sendAudioFrame(data: ArrayBuffer | ArrayBufferView): boolean;
  stopAndDrain?(drainTimeoutMs?: number, quietWindowMs?: number): Promise<void>;
  onReconnectFailed(cb: () => void): void;
}

type StreamingResampler = ReturnType<typeof createStreamingResampler>;

export function useSandboxRecording(): SandboxRecording {
  const [status, setStatus] = useState<SandboxRecordingStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([]);

  const clientRef = useRef<SttStreamClient | null>(null);
  const captureRef = useRef<AudioCaptureHandle | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const resamplerRef = useRef<StreamingResampler | null>(null);
  const sessionRef = useRef<string | null>(null);
  const levelAtRef = useRef(0);
  const busyRef = useRef(false);

  const releaseAudio = useCallback(() => {
    captureRef.current?.destroy();
    captureRef.current = null;
    resamplerRef.current = null;
    if (contextRef.current && contextRef.current.state !== 'closed') void contextRef.current.close().catch(() => {});
    contextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const closeSession = useCallback(() => {
    const id = sessionRef.current;
    sessionRef.current = null;
    setSessionId(null);
    if (id) void closeSttStreamSession(id).catch(() => {});
  }, []);

  // Unmount: never leave a hot mic or a held concurrency slot behind.
  useEffect(
    () => () => {
      captureRef.current?.destroy();
      if (contextRef.current && contextRef.current.state !== 'closed') void contextRef.current.close().catch(() => {});
      streamRef.current?.getTracks().forEach((track) => track.stop());
      clientRef.current?.disconnect();
      if (sessionRef.current) void closeSttStreamSession(sessionRef.current).catch(() => {});
    },
    [],
  );

  const fail = useCallback(
    (message: string) => {
      clientRef.current?.disconnect();
      clientRef.current = null;
      releaseAudio();
      closeSession();
      setError(message);
      setStatus('error');
    },
    [closeSession, releaseAudio],
  );

  const start = useCallback(
    async (options: StartSandboxRecordingOptions): Promise<string | null> => {
      if (busyRef.current) return null;
      busyRef.current = true;
      try {
        setError(null);
        setLevels([]);
        setStatus('starting');

        let stream: MediaStream;
        try {
          if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture needs a secure context.');
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { sampleRate: SAMPLE_RATE, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        } catch (micError) {
          const denied = micError instanceof DOMException && (micError.name === 'NotAllowedError' || micError.name === 'SecurityError');
          setError(denied ? 'The microphone was blocked. Allow it in the browser to record.' : `The microphone could not start: ${micError instanceof Error ? micError.message : 'unknown error'}`);
          setStatus('error');
          return null;
        }
        streamRef.current = stream;
        const [track] = stream.getAudioTracks();
        if (!track) {
          fail('The microphone gave no audio track.');
          return null;
        }

        // The granted rate is known BEFORE anything is declared (TASK-985 M-55).
        const context = new AudioContext({ sampleRate: SAMPLE_RATE });
        contextRef.current = context;
        const granted = typeof context.sampleRate === 'number' && context.sampleRate > 0 ? context.sampleRate : SAMPLE_RATE;
        resamplerRef.current = granted === SAMPLE_RATE ? null : createStreamingResampler(granted, SAMPLE_RATE);

        let created;
        try {
          created = await createSttStreamSession({ ...(options.agentSlug ? { agentSlug: options.agentSlug } : {}), sampleRate: SAMPLE_RATE, ...(options.language ? { language: options.language } : {}) });
        } catch (createError) {
          fail(createError instanceof Error ? createError.message : 'The recording session could not be created.');
          return null;
        }
        sessionRef.current = created.sessionId;
        setSessionId(created.sessionId);

        const client = new SttWebSocketClient(
          undefined,
          {
            enabled: true,
            maxAttempts: 5,
            baseDelayMs: 1_000,
            maxDelayMs: 15_000,
            refreshTicket: async () => (await refreshSttStreamTicket(created.sessionId)).ticket,
          },
          false,
        ) as unknown as SttStreamClient;
        clientRef.current = client;
        client.onReconnectFailed(() => fail('The recording connection was lost.'));

        try {
          await client.connect(
            buildSttWsUrl(publicEnv.apiHost, created.wsUrl || '/ws/stt/stream', { sessionId: created.sessionId, ticket: created.ticket, tenantId: options.tenantId }),
          );
        } catch {
          fail('The recording connection was refused. Start again to mint a fresh ticket.');
          return null;
        }

        try {
          captureRef.current = await createAudioCapture(context, track, (frame) => {
            if (!client.isConnected()) return;
            const resampler = resamplerRef.current;
            const wire = resampler ? resampler.push(frame) : frame;
            if (wire.length > 0) client.sendAudioFrame(float32ToInt16(wire));
            const now = Date.now();
            if (now - levelAtRef.current >= LEVEL_COMMIT_MS || levelAtRef.current === 0) {
              levelAtRef.current = now;
              let sum = 0;
              for (const sample of frame) sum += sample * sample;
              const level = Math.min(100, Math.round(Math.sqrt(sum / (frame.length || 1)) * 300));
              setLevels((previous) => [...previous, level].slice(-LEVEL_HISTORY));
            }
          });
        } catch (captureError) {
          fail(captureError instanceof Error ? captureError.message : 'Audio capture failed to start.');
          return null;
        }

        setStatus('recording');
        return created.sessionId;
      } finally {
        busyRef.current = false;
      }
    },
    [fail],
  );

  const stop = useCallback(async () => {
    if (!clientRef.current && !sessionRef.current) {
      releaseAudio();
      setStatus('idle');
      return;
    }
    setStatus('stopping');
    const resampler = resamplerRef.current;
    const client = clientRef.current;
    if (resampler && client?.isConnected()) {
      const tail = resampler.flush();
      if (tail.length > 0) client.sendAudioFrame(float32ToInt16(tail));
    }
    // Mic off immediately; then wait for the transcript tail.
    releaseAudio();
    clientRef.current = null;
    if (client) {
      try {
        if (client.isConnected() && client.stopAndDrain) await client.stopAndDrain();
        else client.disconnect();
      } catch {
        client.disconnect();
      }
    }
    const id = sessionRef.current;
    sessionRef.current = null;
    setSessionId(null);
    if (id) await closeSttStreamSession(id).catch(() => {});
    setStatus('idle');
  }, [releaseAudio]);

  return { status, error, sessionId, levels, start, stop };
}
