/**
 * Minimal live-transcription demo (TASK-985 M-54).
 *
 * Previously this file hand-rolled the whole `/ws/stt/stream` protocol against
 * a raw `WebSocket`: its own reconnect story (none), its own readiness story
 * (none — it started sending on `onopen`), its own downsampler (a box average,
 * which aliases), and a stop that sent `{type:'stop'}` and `{type:'close'}`
 * back to back and closed the socket on the same tick. That last one is the
 * interesting bug: `stop` is what makes the server FINALIZE, so the final
 * transcript of the recording is emitted *after* it — into a socket this file
 * had already closed. The demo silently taught every reader to lose their last
 * sentence.
 *
 * It now uses `SttWebSocketClient` from `@arcaai/vox/core`, which is the same
 * client the admin console uses, and which owns all four of those concerns:
 * ticket-refreshing reconnects, the `ready` gate, the stop-DRAIN (stop → tail
 * finals → `{type:'close'}` → disconnect), and backpressure accounting.
 *
 * What is deliberately still hand-written here is the CAPTURE — a
 * `ScriptProcessorNode` and a simple decimator — because this app's job is to
 * be readable with no SDK beyond the socket client. A production browser
 * integration should use `useArcaAudio` from `@arcaai/vox`, which does capture
 * properly (worklet, anti-aliased rate conversion, device handling).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SttWebSocketClient } from '@arcaai/vox/core';

type LiveTranscriptionDemoProps = {
  apiBaseUrl: string;
  /**
   * The published ASR Agent to transcribe with (TASK-865). Omit it and the
   * tenant's own agent assignment decides — which is the recommended default.
   */
  agentSlug?: string;
  /** @deprecated TASK-865 — removed in R4. Prefer `agentSlug`, or neither. */
  pipelineId?: string;
  apiKey?: string;
  tenantId?: string;
};

type StreamSessionResponse = {
  sessionId: string;
  status: string;
  wsUrl: string;
  ticket: string;
  ticketExpiresAt?: number;
  maxConcurrent?: number;
  currentActive?: number;
};

/** The wire rate the session declares. Frames are converted to it before sending. */
const WIRE_SAMPLE_RATE = 16000;

export const LiveTranscriptionDemo: React.FC<LiveTranscriptionDemoProps> = ({ apiBaseUrl, agentSlug, pipelineId, apiKey, tenantId }) => {
  const [status, setStatus] = useState<string>('Idle');
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [transcript, setTranscript] = useState<string>('');

  const clientRef = useRef<SttWebSocketClient | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const isStoppingRef = useRef<boolean>(false);

  const appendTranscript = useCallback((line: string) => {
    setTranscript((prev) => prev + line + '\n');
  }, []);

  /**
   * Decimate to 16 kHz by averaging.
   *
   * Good enough to read; NOT good enough to ship. It performs no low-pass
   * filtering, so content above 8 kHz folds back into the speech band as
   * aliasing and costs consonant accuracy. The SDK's own path
   * (`@arcaai/stt`'s `createStreamingResampler`) uses a Kaiser-windowed-sinc
   * polyphase converter that keeps kernel history across frames; use that, not
   * this, in anything real.
   */
  const downsample = useCallback((buffer: Float32Array, inputSampleRate: number): Float32Array => {
    if (inputSampleRate <= WIRE_SAMPLE_RATE) return buffer;

    const ratio = inputSampleRate / WIRE_SAMPLE_RATE;
    const result = new Float32Array(Math.round(buffer.length / ratio));
    let readCursor = 0;

    for (let i = 0; i < result.length; i += 1) {
      const nextCursor = Math.round((i + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (let j = readCursor; j < nextCursor && j < buffer.length; j += 1) {
        sum += buffer[j] ?? 0;
        count += 1;
      }
      result[i] = count > 0 ? sum / count : 0;
      readCursor = nextCursor;
    }

    return result;
  }, []);

  const toInt16 = useCallback((buffer: Float32Array): Int16Array => {
    const result = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, buffer[i] ?? 0));
      result[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return result;
  }, []);

  const buildRequestHeaders = useCallback(() => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-API-Key'] = apiKey;
    if (tenantId) headers['X-Tenant-ID'] = tenantId;
    return headers;
  }, [apiKey, tenantId]);

  const deleteStreamSession = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;

    try {
      await fetch(`${apiBaseUrl}/api/v1/audio/transcription-jobs/stream/session/${sessionId}`, {
        method: 'DELETE',
        headers: buildRequestHeaders(),
      });
    } catch (err) {
      console.error('Failed to delete streaming session', err);
    } finally {
      sessionIdRef.current = null;
    }
  }, [apiBaseUrl, buildRequestHeaders]);

  const teardownAudio = useCallback(() => {
    if (processorNodeRef.current) {
      processorNodeRef.current.onaudioprocess = null;
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  const stopAll = useCallback(async () => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;

    try {
      // Microphone off first — the recording indicator must not stay lit while
      // we wait for the tail.
      teardownAudio();

      const client = clientRef.current;
      clientRef.current = null;

      if (client) {
        // THE POINT OF THIS FILE'S REWRITE. `stopAndDrain()` sends
        // `{type:'stop'}`, keeps the socket open until the server's terminal
        // status (so the final transcript still arrives), then sends
        // `{type:'close'}` and disconnects. The old code sent both frames and
        // closed immediately, and the last utterance was lost from the screen
        // every single time.
        setStatus('Finalizing…');
        try {
          await client.stopAndDrain();
        } catch (err) {
          console.error('Drain failed; closing anyway', err);
          client.disconnect();
        }
      }

      await deleteStreamSession();
      setStatus('Stopped');
    } finally {
      setIsRunning(false);
      isStoppingRef.current = false;
    }
  }, [deleteStreamSession, teardownAudio]);

  const start = useCallback(async () => {
    setStatus('Creating streaming session…');
    setTranscript('');
    setIsRunning(true);

    try {
      if (!apiKey) throw new Error('Missing apiKey');
      if (!tenantId) throw new Error('Missing tenantId');

      // Selection is `agentSlug` or nothing: omit both and the tenant's
      // agent-assignment cascade picks. `pipelineId` is the deprecated
      // selector and is only sent when a caller explicitly still passes one.
      const res = await fetch(`${apiBaseUrl}/api/v1/audio/transcription-jobs/stream/session`, {
        method: 'POST',
        headers: buildRequestHeaders(),
        body: JSON.stringify({
          ...(agentSlug ? { agentSlug } : pipelineId ? { pipelineId } : {}),
          sampleRate: WIRE_SAMPLE_RATE,
        }),
      });

      if (!res.ok) {
        throw new Error(`Session request failed: ${res.status} ${await res.text()}`);
      }
      const session: StreamSessionResponse = await res.json();
      sessionIdRef.current = session.sessionId;

      const client = new SttWebSocketClient(undefined, {
        enabled: true,
        // Every reconnect needs a FRESH ticket: the first one is consumed by
        // the first handshake, so reusing the URL verbatim closes 4401.
        refreshTicket: async () => {
          const refreshed = await fetch(
            `${apiBaseUrl}/api/v1/audio/transcription-jobs/stream/session/${session.sessionId}/refresh-ticket`,
            { method: 'POST', headers: buildRequestHeaders() },
          ).then((r) => r.json());
          return refreshed.ticket as string;
        },
      });
      clientRef.current = client;

      client.onTranscript((result) => {
        appendTranscript(`${result.isFinal ? '[FINAL] ' : '[PARTIAL] '}${result.text}`);
      });
      client.onStatus((update) => {
        appendTranscript(`[STATUS] ${update.status}${update.message ? ` ${update.message}` : ''}`);
      });
      client.onWsError((err) => {
        appendTranscript(`[ERROR] ${err.code}: ${err.message}`);
      });
      // Results the gateway DISCARDED — text that was produced and dropped, so
      // no reconnect brings it back. Worth showing in a demo precisely because
      // it is the failure that otherwise looks like silence (TASK-985 M-43).
      client.onGap((gap) => {
        appendTranscript(`[GAP] transcript text was dropped (${gap.reason})`);
      });
      client.onBackpressureDrop(() => {
        appendTranscript('[DROP] outbound audio was dropped — the uplink is behind');
      });

      const wsBase = apiBaseUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
      const wsPath = session.wsUrl.startsWith('/') ? session.wsUrl : `/${session.wsUrl}`;
      const wsUrl =
        `${wsBase}${wsPath}?sessionId=${encodeURIComponent(session.sessionId)}` +
        `&ticket=${encodeURIComponent(session.ticket)}&tenantId=${encodeURIComponent(tenantId)}`;

      setStatus(`Connecting WebSocket for session ${session.sessionId}…`);
      await client.connect(wsUrl);

      // An OPEN socket is not a ready one: the gateway registers its
      // result-stream handler and only then emits `{type:'ready'}`. Audio sent
      // before that frame is ingested with nothing listening for its results,
      // so the first partials of a recording can vanish (TASK-985 M-22).
      // Resolves immediately once `ready` has arrived, and resolves anyway on
      // its own timeout so an older gateway still works.
      setStatus('Waiting for the session to be ready…');
      await client.whenReady();

      setStatus('Requesting microphone access…');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: WIRE_SAMPLE_RATE },
        video: false,
      });
      mediaStreamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;

      const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      processorNodeRef.current = processorNode;

      processorNode.onaudioprocess = (event) => {
        const live = clientRef.current;
        if (!live || !live.isConnected()) return;
        const input = event.inputBuffer.getChannelData(0);
        // `audioContext.sampleRate` is the rate the browser GAVE us, which is
        // not necessarily the one requested above — read it, never assume it.
        live.sendAudioFrame(toInt16(downsample(input, audioContext.sampleRate)));
      };

      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);

      setStatus('Streaming microphone audio…');
    } catch (err: unknown) {
      console.error(err);
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      teardownAudio();
      clientRef.current?.disconnect();
      clientRef.current = null;
      void deleteStreamSession();
      setIsRunning(false);
    }
  }, [agentSlug, apiBaseUrl, apiKey, appendTranscript, buildRequestHeaders, deleteStreamSession, downsample, pipelineId, teardownAudio, tenantId, toInt16]);

  useEffect(() => {
    return () => {
      void stopAll();
    };
  }, [stopAll]);

  return (
    <div style={{ maxWidth: 800, margin: '2rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Live Transcription Demo</h1>

      <p>
        <button onClick={start} disabled={isRunning}>
          Start
        </button>
        <button onClick={stopAll} disabled={!isRunning}>
          Stop
        </button>
      </p>

      <div style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: '#555' }}>Status: {status}</div>

      <div
        style={{
          marginTop: '1rem',
          border: '1px solid #ddd',
          padding: '1rem',
          minHeight: 200,
          whiteSpace: 'pre-wrap',
          background: '#fafafa',
        }}
      >
        {transcript || 'Transcription will appear here...'}
      </div>
    </div>
  );
};
