/**
 * useDualCapture tests (TASK-339 follow-up — genuine processed PCM).
 *
 * Verifies the hook wires the GENUINE processed-audio tap into the recorder,
 * uploads raw + processed blobs, registers both ids, and CLEARLY marks the
 * artifact (filename + exposed `processedSource`) when it falls back to the
 * approximation. The DOM-bound `DualStreamRecorder` is mocked so we assert the
 * wiring + persistence, not Web Audio internals.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  apiClient: { post: vi.fn(), get: vi.fn(), getBaseUrl: vi.fn(() => 'http://localhost') },
  registerDualRecording: vi.fn(),
  ctor: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('@arcaai/vox', () => ({
  useArcaStore: (selector: (s: { apiClient: unknown }) => unknown) => selector({ apiClient: h.apiClient }),
  useStorage: () => ({ uploadFile: h.uploadFile }),
  createProcessedAudioTap: vi.fn(),
}));

vi.mock('../../api/clinical-workspace.api', () => ({
  registerDualRecording: h.registerDualRecording,
}));

vi.mock('../../lib/dual-capture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/dual-capture')>();
  class MockDualStreamRecorder {
    constructor(inputStream: unknown, options: unknown) {
      h.ctor(inputStream, options);
    }
    start = h.start;
    stop = h.stop;
  }
  return { ...actual, DualStreamRecorder: MockDualStreamRecorder };
});

import { useDualCapture } from '../use-dual-capture';

const fakeStream = { getTracks: () => [] } as unknown as MediaStream;

beforeEach(() => {
  vi.clearAllMocks();
  h.uploadFile.mockImplementation(async (_bucket: string, file: File) => ({ key: `key-${file.name}` }));
  h.registerDualRecording.mockResolvedValue({});
});

describe('useDualCapture', () => {
  it('passes a genuine processed-tap factory to the recorder', () => {
    const { result } = renderHook(() => useDualCapture('consult-1'));
    act(() => result.current.start(fakeStream));

    expect(h.ctor).toHaveBeenCalledWith(fakeStream, expect.objectContaining({ processedTapFactory: expect.any(Function) }));
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('capturing');
  });

  it('uploads raw + genuine processed and registers both ids', async () => {
    h.stop.mockResolvedValue({
      raw: new Blob(['r']),
      processed: new Blob(['p']),
      mimeType: 'audio/webm',
      durationMs: 1000,
      processedSource: 'noise-filter',
    });

    const { result } = renderHook(() => useDualCapture('consult-1'));
    act(() => result.current.start(fakeStream));

    let res: { rawMediaId: string; processedMediaId: string; processedSource: string } | null = null;
    await act(async () => {
      res = await result.current.stopAndPersist();
    });

    const names = h.uploadFile.mock.calls.map((c) => (c[1] as File).name);
    expect(names).toEqual(expect.arrayContaining(['raw-capture.webm', 'processed-capture.webm']));
    expect(names).not.toContain('processed-approx-capture.webm');

    expect(h.registerDualRecording).toHaveBeenCalledWith(
      h.apiClient,
      'consult-1',
      expect.objectContaining({
        rawMediaId: 'key-raw-capture.webm',
        processedMediaId: 'key-processed-capture.webm',
        mediaId: 'key-processed-capture.webm',
        durationMs: 1000,
      }),
    );
    expect(res).toEqual({ rawMediaId: 'key-raw-capture.webm', processedMediaId: 'key-processed-capture.webm', processedSource: 'noise-filter' });
    expect(result.current.processedSource).toBe('noise-filter');
    expect(result.current.status).toBe('saved');
  });

  it('clearly marks the processed artifact when falling back to the approximation', async () => {
    h.stop.mockResolvedValue({
      raw: new Blob(['r']),
      processed: new Blob(['p']),
      mimeType: 'audio/webm',
      durationMs: 500,
      processedSource: 'approximation',
    });

    const { result } = renderHook(() => useDualCapture('consult-1'));
    act(() => result.current.start(fakeStream));
    await act(async () => {
      await result.current.stopAndPersist();
    });

    const names = h.uploadFile.mock.calls.map((c) => (c[1] as File).name);
    expect(names).toEqual(expect.arrayContaining(['raw-capture.webm', 'processed-approx-capture.webm']));
    expect(result.current.processedSource).toBe('approximation');
  });
});
