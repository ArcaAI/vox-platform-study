/**
 * useTtsPlayback hook orchestration.
 *
 * @vitest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPlayer, mockStore } = vi.hoisted(() => {
  const mockPlayer = {
    start: vi.fn(async () => undefined),
    enqueuePcm16: vi.fn(),
    end: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
  const mockStore = {
    apiClient: { synthesizeSpeech: vi.fn() } as { synthesizeSpeech: ReturnType<typeof vi.fn> } | null,
    ttsIsPlaying: false,
    ttsIsLoading: false,
    ttsError: null as Error | null,
    setTtsIsPlaying: vi.fn(),
    setTtsIsLoading: vi.fn(),
    setTtsError: vi.fn(),
  };
  return { mockPlayer, mockStore };
});

vi.mock('../../store', () => ({ useAgenticStore: vi.fn(() => mockStore) }));
vi.mock('../../core/TtsPlaybackPlayer', () => ({
  // Regular function (not arrow) so `new TtsPlaybackPlayer()` returns the mock.
  TtsPlaybackPlayer: vi.fn(function () {
    return mockPlayer;
  }),
}));

import { useTtsPlayback } from '../useTtsPlayback';

function fakeBodyStream(chunks: Uint8Array[]) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
    }),
  };
}

describe('useTtsPlayback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.apiClient = { synthesizeSpeech: vi.fn() };
  });

  it('speak() loads, streams chunks into the player, and marks playing', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    mockStore.apiClient!.synthesizeSpeech.mockResolvedValue({ body: fakeBodyStream(chunks) });

    const { result } = renderHook(() => useTtsPlayback());
    await act(async () => {
      await result.current.speak('Hello.', { voice: 'en-female-1' });
    });

    expect(mockStore.apiClient!.synthesizeSpeech).toHaveBeenCalledWith(
      'Hello.',
      expect.objectContaining({ voice: 'en-female-1', response_format: 'pcm', stream_format: 'audio' }),
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(mockStore.setTtsIsLoading).toHaveBeenCalledWith(true);
    expect(mockPlayer.start).toHaveBeenCalled();
    expect(mockStore.setTtsIsPlaying).toHaveBeenCalledWith(true);
    expect(mockPlayer.enqueuePcm16).toHaveBeenCalledTimes(2);
    expect(mockPlayer.end).toHaveBeenCalled();
  });

  it('speak() throws when the SDK is not initialized', async () => {
    mockStore.apiClient = null;
    const { result } = renderHook(() => useTtsPlayback());
    await expect(result.current.speak('hi', { voice: 'v' })).rejects.toThrow('SDK not initialized');
  });

  it('stop() resets playing/loading state', async () => {
    const { result } = renderHook(() => useTtsPlayback());
    await act(async () => {
      await result.current.stop();
    });
    expect(mockStore.setTtsIsPlaying).toHaveBeenCalledWith(false);
    expect(mockStore.setTtsIsLoading).toHaveBeenCalledWith(false);
  });

  it('surfaces synthesis errors to ttsError and rethrows', async () => {
    mockStore.apiClient!.synthesizeSpeech.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useTtsPlayback());
    await expect(
      act(async () => {
        await result.current.speak('hi', { voice: 'v' });
      }),
    ).rejects.toThrow('boom');
    expect(mockStore.setTtsError).toHaveBeenCalled();
  });
});
