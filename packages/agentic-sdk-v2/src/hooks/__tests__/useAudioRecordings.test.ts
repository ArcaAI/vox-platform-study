/**
 * useAudioRecordings Hook Tests (dual-capture X8)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAudioRecordings } from '../useAudioRecordings';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { AUDIO_RECORDING_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

const recordings = [
  { id: 'ar-1', mediaId: 'm-1', sequenceNumber: 1, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'ar-2', mediaId: 'm-2', rawMediaId: 'm-raw', processedMediaId: 'm-proc', sequenceNumber: 2, createdAt: '2026-01-02T00:00:00.000Z' },
];

describe('useAudioRecordings (TASK-329 P2)', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStore: any;
  const mockGet = vi.fn();
  const mockPost = vi.fn();

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockGet.mockReset();
    mockPost.mockReset();
    mockStore = { apiClient: { get: mockGet, post: mockPost, patch: vi.fn(), delete: vi.fn() }, logger: mockLogger };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => vi.clearAllMocks());

  it('lists recordings for a consultation', async () => {
    mockGet.mockResolvedValue(recordings);
    const { result } = renderHook(() => useAudioRecordings());

    let returned: unknown;
    await act(async () => {
      returned = await result.current.list('c-1');
    });

    expect(mockGet).toHaveBeenCalledWith(AUDIO_RECORDING_ENDPOINTS.LIST('c-1'));
    expect(returned).toEqual(recordings);
    expect(result.current.recordings).toEqual(recordings);
  });

  it('adds a dual-capture recording (raw+processed) then refreshes the list', async () => {
    const container = { id: 'ctx-audio-1' };
    mockPost.mockResolvedValue(container);
    mockGet.mockResolvedValue(recordings);
    const { result } = renderHook(() => useAudioRecordings());

    const input = { mediaId: 'm-2', rawMediaId: 'm-raw', processedMediaId: 'm-proc' };
    let returned: unknown;
    await act(async () => {
      returned = await result.current.add('c-1', input);
    });

    expect(mockPost).toHaveBeenCalledWith(AUDIO_RECORDING_ENDPOINTS.ADD('c-1'), input);
    expect(mockGet).toHaveBeenCalledWith(AUDIO_RECORDING_ENDPOINTS.LIST('c-1'));
    expect(returned).toEqual(container);
    expect(result.current.recordings).toEqual(recordings);
  });

  it('sets error when add fails', async () => {
    const error = new Error('nope');
    mockPost.mockRejectedValue(error);
    const { result } = renderHook(() => useAudioRecordings());

    await act(async () => {
      try {
        await result.current.add('c-1', { mediaId: 'm-1' });
      } catch {
        /* expected */
      }
    });

    expect(result.current.error).toEqual(error);
  });
});
