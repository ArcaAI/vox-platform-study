/**
 * TASK-491 — `useTtsPlayback`: play synthesized speech from the gateway TTS proxy.
 *
 * Streams `POST /api/v1/speech/synthesize` (PCM, `stream_format:"audio"`) through
 * the SDK's authed `AgenticClient`, pumping chunks into a Web Audio ring buffer
 * (`TtsPlaybackPlayer`) for gapless playback of the "summary read-aloud" use case.
 */

import { useCallback, useMemo, useRef } from 'react';

import { TtsPlaybackPlayer } from '../core/TtsPlaybackPlayer';
import { useAgenticStore } from '../store';

export interface SpeakOptions {
  /** Stable internal voice id, e.g. `en-female-1` / `ml-female-1`. */
  voice: string;
  /** Playback rate 0.25–4.0 (default 1.0). */
  speed?: number;
}

export interface UseTtsPlayback {
  isPlaying: boolean;
  isLoading: boolean;
  error: Error | null;
  speak: (input: string, options: SpeakOptions) => Promise<void>;
  stop: () => Promise<void>;
}

export function useTtsPlayback(): UseTtsPlayback {
  const store = useAgenticStore();
  const { apiClient, ttsIsPlaying, ttsIsLoading, ttsError, setTtsIsPlaying, setTtsIsLoading, setTtsError } = store;

  const playerRef = useRef<TtsPlaybackPlayer | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (playerRef.current) {
      await playerRef.current.stop();
      playerRef.current = null;
    }
    setTtsIsPlaying(false);
    setTtsIsLoading(false);
  }, [setTtsIsPlaying, setTtsIsLoading]);

  const speak = useCallback(
    async (input: string, options: SpeakOptions): Promise<void> => {
      if (!apiClient) throw new Error('SDK not initialized');
      if (!input.trim()) return;

      await stop(); // cancel any in-flight playback first
      setTtsError(null);
      setTtsIsLoading(true);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const response = await apiClient.synthesizeSpeech(
          input,
          { voice: options.voice, speed: options.speed, response_format: 'pcm', stream_format: 'audio' },
          { signal: abort.signal },
        );
        const body = response.body;
        if (!body) throw new Error('TTS response has no readable body stream');

        const player = new TtsPlaybackPlayer({ onEnded: () => setTtsIsPlaying(false) });
        playerRef.current = player;
        await player.start();
        setTtsIsLoading(false);
        setTtsIsPlaying(true);

        const reader = body.getReader();
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          if (chunk.value && playerRef.current) {
            playerRef.current.enqueuePcm16(chunk.value);
          }
        }
        playerRef.current?.end();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        await stop();
        if (error.name !== 'AbortError') {
          setTtsError(error);
          throw error;
        }
      }
    },
    [apiClient, stop, setTtsError, setTtsIsLoading, setTtsIsPlaying],
  );

  return useMemo(
    () => ({ isPlaying: ttsIsPlaying, isLoading: ttsIsLoading, error: ttsError, speak, stop }),
    [ttsIsPlaying, ttsIsLoading, ttsError, speak, stop],
  );
}
