'use client';

/**
 * Live STT session state machine (frame 51 streaming tab).
 * Flow: mic capture grant → `POST stream/session` through the BFF → WS
 * DIRECTLY to the gateway (`publicEnv.apiHost`, one-shot ticket + tenant
 * claim in the URL) → Int16 PCM frames from the `@arcaai/stt` worklet →
 * stop sends `{type:'stop'}`, tears down and DELETEs the session.
 *
 * Reference wiring: the deprecated ui-playground `use-realtime-transcription`
 * (API usage only — auth here is the console BFF, never sessionStorage).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
// `createStreamingResampler` is PCM plumbing, not a model — the same carve-out
// that already lets this file import `createAudioCapture` / `float32ToInt16`
// under the TASK-865 client-AI import ban. The type is taken via `ReturnType`
// rather than imported, so exactly ONE new name needs allow-listing.
import { createAudioCapture, createStreamingResampler, float32ToInt16, type AudioCaptureHandle } from '@arcaai/stt';
import { SttWebSocketClient } from '@arcaai/vox/core';
import { publicEnv } from '@/config/public-env';
import { GatewayError } from '@/shared/api';
import { buildStreamWsUrl, closeStreamSession, createStreamSession, refreshStreamTicket } from './client';
import type { WsErrorPayload, WsTranscriptPayload } from './types';

type StreamingResampler = ReturnType<typeof createStreamingResampler>;

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
 * Structural view of `SttWebSocketClient` — @arcaai/vox ships `dts: false`,
 * so the constructed instance is typed locally against the methods this hook
 * uses (and tests fake).
 */
interface SttStreamClient {
  connect(url: string): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  sendAudioFrame(data: ArrayBuffer | ArrayBufferView): boolean;
  sendStop(): void;
  /**
   * Send `{type:'stop'}`, hold the socket open for the tail finals, then send
   * `{type:'close'}` and disconnect (TASK-985 M-05). Optional here only so
   * partial test fakes need not stub it; the real client always implements it.
   */
  stopAndDrain?(drainTimeoutMs?: number, quietWindowMs?: number): Promise<void>;
  onTranscript(cb: (result: WsTranscriptPayload) => void): void;
  onWsError(cb: (error: WsErrorPayload) => void): void;
  onDisconnect(cb: () => void): void;
  onReconnect(cb: (attempt: number) => void): void;
  onReconnectFailed(cb: () => void): void;
  /** Reconnect SUCCESS — the socket genuinely re-opened. Optional so partial test fakes need not stub it; the real client always implements it. */
  onReconnected?(cb: () => void): void;
  /** Optional in this structural view so partial test fakes need not stub it; the real client always implements it. */
  onBackpressureDrop?(cb: (reason: 'queue_full' | 'buffered_amount_high') => void): void;
  /** The gateway DISCARDED results it could not deliver (TASK-985 M-43). */
  onGap?(cb: (gap: { reason: string; droppedPartials?: number; droppedSeq?: number }) => void): void;
}

export interface StartLiveSttOptions {
  /** Published ASR Agent slug; omitted ⇒ the tenant default (TASK-865). */
  agentSlug?: string;
  /** `effectiveTenantId ?? session.user.tenantId` — REQUIRED for the WS tenant-claim guard. */
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
  /** Frames the client dropped at its backpressure watermark on the CURRENT connection (resets on reconnect, mirroring the client). */
  droppedFrameCount: number;
  /**
   * Session-sticky latch: true once ANY outbound audio has been dropped this
   * session. A climbing bufferedAmount usually precedes the disconnect that
   * triggers a reconnect, so this MUST survive reconnects — the durable
   * transcript stays permanently incomplete. Cleared only on start/stop (C6-01).
   */
  audioLostThisSession: boolean;
  /**
   * Session-sticky latch: true once the gateway has reported DISCARDING any
   * transcript result this session (TASK-985 M-43).
   *
   * Deliberately separate from {@link audioLostThisSession}: that one is audio
   * that never reached the server, this one is text the server produced and
   * then dropped. They have different causes and different remedies, and
   * collapsing them would tell a clinician "check your microphone" when the
   * microphone is fine.
   */
  transcriptGapThisSession: boolean;
  /** The most recent gap's reason, for the banner copy. `null` when there has been none. */
  lastGapReason: string | null;
  /**
   * The rate the browser ACTUALLY granted the capture context, which is not
   * necessarily the 16 kHz that was requested. `null` before capture starts.
   */
  captureSampleRate: number | null;
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
  const [audioLostThisSession, setAudioLostThisSession] = useState(false);
  const [transcriptGapThisSession, setTranscriptGapThisSession] = useState(false);
  const [lastGapReason, setLastGapReason] = useState<string | null>(null);
  const [captureSampleRate, setCaptureSampleRate] = useState<number | null>(null);

  const statusRef = useRef<LiveSttStatus>('idle');
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const wsClientRef = useRef<SttStreamClient | null>(null);
  const captureRef = useRef<AudioCaptureHandle | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  /**
   * TASK-985 M-55/M-53 — converts capture frames to the 16 kHz the session
   * DECLARES, keeping kernel history across frames. `null` when the granted
   * context rate already is 16 kHz (the common case), in which case frames pass
   * through untouched.
   */
  const resamplerRef = useRef<StreamingResampler | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const rowIdRef = useRef(0);
  const levelCommitAtRef = useRef(0);

  const releaseAudio = useCallback(() => {
    captureRef.current?.destroy();
    captureRef.current = null;
    resamplerRef.current = null;
    setCaptureSampleRate(null);
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
      // Prefer the canonical label the bridge derived; fall back
      // to the raw speakerId so an older worker/bridge still shows attribution.
      speakerLabel: result.speakerLabel ?? result.speakerId,
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
      setAudioLostThisSession(false);
      setTranscriptGapThisSession(false);
      setLastGapReason(null);
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

      // 1b. Capture context BEFORE the session is created (TASK-985 M-55).
      //
      // `new AudioContext({ sampleRate })` is a REQUEST. Safari and some
      // ALSA/PulseAudio stacks clamp it to the hardware rate and say nothing.
      // This hook used to create the context AFTER session create, never read
      // the granted rate back, and send un-resampled frames while telling the
      // backend they were 16 kHz — so on those browsers the service received
      // audio running 2.75-3x fast and labelled as if it were not. That does
      // not look like a capture bug; it looks like the model is broken.
      //
      // Creating it here lets the granted rate be KNOWN before anything is
      // declared, and the converter below guarantees the wire really is 16 kHz.
      let audioContext: AudioContext;
      try {
        audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      } catch (contextError) {
        releaseAudio();
        setError(contextError instanceof Error ? contextError.message : 'Could not open an audio context.');
        setStatus('error');
        return;
      }
      audioContextRef.current = audioContext;
      // A runtime that does not report a rate is a runtime we cannot convert
      // for; assume the request was honoured rather than building a converter
      // out of `undefined`. Real browsers always report one.
      const grantedRate =
        typeof audioContext.sampleRate === 'number' && Number.isFinite(audioContext.sampleRate) && audioContext.sampleRate > 0
          ? audioContext.sampleRate
          : SAMPLE_RATE;
      setCaptureSampleRate(grantedRate);
      resamplerRef.current = grantedRate === SAMPLE_RATE ? null : createStreamingResampler(grantedRate, SAMPLE_RATE);

      // 2. Session create through the BFF (429 = designed quota panel).
      setStatus('creating_session');
      let created;
      try {
        created = await createStreamSession({ ...(options.agentSlug ? { agentSlug: options.agentSlug } : {}), sampleRate: SAMPLE_RATE, language: options.language });
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
      // ticket through the BFF refresh route.
      setStatus('connecting');
      const client = new SttWebSocketClient(
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
        // Fresh (empty) send buffer → the per-connection count resets, but
        // audioLostThisSession deliberately does NOT: the frames dropped
        // before the disconnect are gone from the transcript for good.
        setDroppedFrameCount(0);
        // Attempt-START (during backoff) — the socket is not back yet, so
        // stay 'reconnecting' until onReconnected fires.
        setStatus('reconnecting');
      });
      client.onReconnected?.(() => {
        // C6-02 — a reconnect attempt genuinely re-opened the socket, so
        // the stream is live again. Guard like onDisconnect (:300) so a
        // stop()/idle already in flight is not clobbered back to 'live'.
        if (statusRef.current !== 'stopping' && statusRef.current !== 'idle') {
          setStatus('streaming');
        }
      });
      client.onReconnectFailed(() => {
        // C6-03 — reconnection is exhausted (terminal). Mirror the
        // handshake-fail cleanup (:335-341): release the mic and DELETE
        // the gateway session so a dead session leaks neither a hot mic
        // (privacy) nor the tenant concurrency slot (held until it reaps).
        wsClientRef.current = null;
        releaseAudio();
        if (sessionIdRef.current) {
          void closeStreamSession(sessionIdRef.current).catch(() => {});
          sessionIdRef.current = null;
        }
        setSession(null);
        setError(GENERIC_AUTH_COPY);
        setStatus('error');
      });
      // C6-01 — the client silently drops outbound audio above its 1 MiB
      // bufferedAmount watermark. Latch a session-sticky signal so the
      // clinician sees the transcript is permanently incomplete, and count
      // per-connection drops for the live indicator.
      client.onBackpressureDrop?.(() => {
        setDroppedFrameCount((count) => count + 1);
        setAudioLostThisSession(true);
      });
      // TASK-985 M-43 — the DOWNLINK loss. Until the client modelled the `gap`
      // frame it was logged as an unknown message type and the transcript just
      // silently skipped, under a green "streaming" badge.
      client.onGap?.((gap) => {
        setTranscriptGapThisSession(true);
        setLastGapReason(gap.reason);
      });

      const wsUrl = buildStreamWsUrl(publicEnv.apiHost, created.wsUrl || '/ws/stt/stream', {
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

      // 4. Worklet capture — coalesced Float32 frames, sent as Int16 PCM at the
      //    rate the session was told about, whatever rate the browser granted.
      try {
        captureRef.current = await createAudioCapture(audioContext, track, (frame) => {
          if (!client.isConnected()) return;
          const resampler = resamplerRef.current;
          const wireFrame = resampler ? resampler.push(frame) : frame;
          if (wireFrame.length > 0) client.sendAudioFrame(float32ToInt16(wireFrame));

          const now = Date.now();
          if (now - levelCommitAtRef.current >= LEVEL_COMMIT_MS) {
            levelCommitAtRef.current = now;
            // Measured on the RAW capture frame on purpose: the meter reports
            // what the microphone is hearing, not what survived conversion.
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

    // Microphone off IMMEDIATELY — the recording indicator must not stay lit
    // while we wait for the tail. Then, and only then, wait for the transcript.
    releaseAudio();

    const client = wsClientRef.current;
    wsClientRef.current = null;
    if (client) {
      // TASK-985 M-05 — DRAIN, do not slam the door.
      //
      // This used to send `{type:'stop'}` and call `disconnect()` on the same
      // tick. `stop` is what makes the server FINALIZE, so the last utterance
      // of the consultation is emitted after it — straight into a socket this
      // hook had already closed. The clinician watched their final sentence
      // never appear (it is in the durable transcript; it is missing from the
      // screen they were reading).
      //
      // `stopAndDrain()` sends the same `{type:'stop'}` frame, holds the socket
      // open for the tail, and then sends `{type:'close'}` so the gateway files
      // this as the deliberate stop it was rather than waiting out its grace
      // window and recording the session as interrupted.
      try {
        if (client.isConnected() && client.stopAndDrain) {
          await client.stopAndDrain();
        } else {
          client.disconnect();
        }
      } catch {
        // A drain that throws must not strand the session DELETE below.
        client.disconnect();
      }
    }

    if (sessionIdRef.current) {
      await closeStreamSession(sessionIdRef.current).catch(() => {});
      sessionIdRef.current = null;
    }

    setSession(null);
    setReconnectAttempt(0);
    setDroppedFrameCount(0);
    setAudioLostThisSession(false);
    setTranscriptGapThisSession(false);
    setLastGapReason(null);
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
    audioLostThisSession,
    transcriptGapThisSession,
    lastGapReason,
    captureSampleRate,
    start,
    stop,
  };
}
