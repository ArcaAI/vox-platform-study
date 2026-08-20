/**
 * `useTtsStream`: speak-while-generating over a WS duplex.
 *
 * Opens the gateway WS (`/ws/tts/stream`) with a single-use stream ticket,
 * pushes summary tokens in as TEXT streams them, and plays the returned PCM
 * frames through the `TtsPlaybackPlayer` — so the clinician hears the
 * summary forming instead of waiting for the whole read-aloud.
 *
 * Typical use:
 *   const tts = useTtsStream();
 *   await tts.open({ voice: 'en-female-1' });   // resolves once the server is ready
 *   for await (const token of textStream) tts.pushText(token);
 *   tts.end();                                   // server drains + fires onEnded
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { TtsPlaybackPlayer } from '../core/TtsPlaybackPlayer';
import { useAgenticStore } from '../store';

export interface TtsStreamOptions {
  /** Stable internal voice id, e.g. `en-female-1` / `ml-female-1`. */
  voice: string;
  /** Playback rate 0.25–4.0 (default 1.0). Note: Azure native duplex is 1.0 only. */
  speed?: number;
}

export interface UseTtsStream {
  isConnecting: boolean;
  isStreaming: boolean;
  error: Error | null;
  /** Mint a ticket, open the WS, send init; resolves once the server is `ready`. */
  open: (options: TtsStreamOptions) => Promise<void>;
  /** Feed a text fragment (a trailing space marks a likely sentence boundary). */
  pushText: (text: string) => void;
  /** Signal end-of-input; the server drains the remainder and finishes. */
  end: () => void;
  /** Hard-stop: close the socket and tear down playback. */
  close: () => Promise<void>;
}

interface ServerMessage {
  type: 'ready' | 'done' | 'error';
  code?: string;
  message?: string;
}

const STREAM_PATH = '/ws/tts/stream';

function toWsBase(apiClient: { getWsUrl(): string | undefined; getBaseUrl(): string }): string {
  const explicit = apiClient.getWsUrl();
  if (explicit) return explicit.replace(/\/+$/, '');
  // Fall back to the REST base's ORIGIN (not its path): the gateway WS path is
  // absolute (`/ws/tts/stream`), so a REST base like `https://gw/api/v1` must
  // not leak its `/api/v1` suffix into the WS URL.
  const base = apiClient.getBaseUrl();
  try {
    const u = new URL(base);
    return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
  } catch {
    return base.replace(/^http/, 'ws').replace(/\/+$/, '');
  }
}

export function useTtsStream(): UseTtsStream {
  const store = useAgenticStore();
  const { apiClient } = store;

  const [isConnecting, setConnecting] = useState(false);
  const [isStreaming, setStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<TtsPlaybackPlayer | null>(null);

  const close = useCallback(async (): Promise<void> => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
    if (playerRef.current) {
      await playerRef.current.stop();
      playerRef.current = null;
    }
    setStreaming(false);
    setConnecting(false);
  }, []);

  const open = useCallback(
    async (options: TtsStreamOptions): Promise<void> => {
      if (!apiClient) throw new Error('SDK not initialized');
      await close(); // tear down any prior stream first
      setError(null);
      setConnecting(true);

      const sessionId = globalThis.crypto?.randomUUID?.() ?? `tts-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

      let ticket: string;
      try {
        const res = await apiClient.post<{ ticket: string }>('/auth/stream-ticket', {
          scope: `tts_session:${sessionId}`,
        });
        ticket = res.ticket;
        if (!ticket) throw new Error('stream-ticket returned no ticket');
      } catch (err) {
        setConnecting(false);
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      }

      const url = `${toWsBase(apiClient)}${STREAM_PATH}?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;
        let ready = false;

        const fail = (e: Error) => {
          if (!ready) {
            setConnecting(false);
            setError(e);
            reject(e);
          } else {
            setError(e);
          }
          void close();
        };

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: 'init',
              voice: options.voice,
              format: 'pcm',
              speed: options.speed ?? 1.0,
            }),
          );
        };

        ws.onmessage = (event: MessageEvent) => {
          if (typeof event.data !== 'string') {
            // Binary PCM frame.
            const bytes = new Uint8Array(event.data as ArrayBuffer);
            playerRef.current?.enqueuePcm16(bytes);
            return;
          }
          let msg: ServerMessage;
          try {
            msg = JSON.parse(event.data) as ServerMessage;
          } catch {
            return;
          }
          if (msg.type === 'ready') {
            void (async () => {
              const player = new TtsPlaybackPlayer({ onEnded: () => setStreaming(false) });
              playerRef.current = player;
              await player.start();
              ready = true;
              setConnecting(false);
              setStreaming(true);
              resolve();
            })().catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
          } else if (msg.type === 'done') {
            playerRef.current?.end();
          } else if (msg.type === 'error') {
            fail(new Error(msg.message || msg.code || 'tts stream error'));
          }
        };

        ws.onerror = () => fail(new Error('tts websocket error'));
        ws.onclose = () => {
          if (!ready) fail(new Error('tts websocket closed before ready'));
        };
      });
    },
    [apiClient, close],
  );

  const pushText = useCallback((text: string): void => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN && text) {
      ws.send(JSON.stringify({ type: 'text', text }));
    }
  }, []);

  const end = useCallback((): void => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'end' }));
    }
  }, []);

  return useMemo(
    () => ({ isConnecting, isStreaming, error, open, pushText, end, close }),
    [isConnecting, isStreaming, error, open, pushText, end, close],
  );
}
