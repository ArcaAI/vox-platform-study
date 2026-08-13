/**
 * useBatchTranscription — the native batch hook.
 *
 * The engine (`BatchTranscriptionQueue`) owns the caps, the scheduling and the
 * transport, and is tested on its own. What is left to pin here is the React
 * seam:
 *   - the limits the GATEWAY resolves win over the built-in defaults, so an
 *     operator lowering `stt.batch.*` moves the client too;
 *   - a limits fetch that fails leaves the documented defaults in force rather
 *     than disabling uploads;
 *   - the queue survives re-renders and is torn down on unmount.
 *
 * @vitest-environment jsdom
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const instances: MockQueue[] = [];

  class MockQueue {
    config: Record<string, unknown>;
    items: unknown[] = [];
    limits = { maxFilesPerBatch: 5, maxDurationMinutes: 60, maxFileSizeBytes: 250 * 1024 * 1024 };
    setLimitsCalls: Record<string, unknown>[] = [];
    setDefaultsCalls: Record<string, unknown>[] = [];
    disposed = false;
    private listeners = new Set<() => void>();

    constructor(config: Record<string, unknown>) {
      this.config = config;
      instances.push(this);
    }
    subscribe(fn: () => void) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    getSnapshot() {
      return this.items;
    }
    getLimits() {
      return this.limits;
    }
    setLimits(limits: Record<string, unknown>) {
      this.setLimitsCalls.push(limits);
      this.limits = { ...this.limits, ...limits } as typeof this.limits;
      this.emit();
    }
    setDefaults(options: Record<string, unknown>) {
      this.setDefaultsCalls.push(options);
    }
    enqueue = vi.fn(() => ['batch-item-1']);
    cancel = vi.fn();
    retry = vi.fn();
    remove = vi.fn();
    clear = vi.fn();
    dispose() {
      this.disposed = true;
    }
    /** Push a new row set the way the engine would. */
    push(items: unknown[]) {
      this.items = items;
      this.emit();
    }
    private emit() {
      for (const fn of this.listeners) fn();
    }
  }

  return { MockQueue, instances, apiClient: { get: vi.fn() } as { get: ReturnType<typeof vi.fn> } };
});

vi.mock('../../core/BatchTranscriptionQueue', () => ({
  BatchTranscriptionQueue: h.MockQueue,
  DEFAULT_BATCH_LIMITS: { maxFilesPerBatch: 5, maxDurationMinutes: 60, maxFileSizeBytes: 250 * 1024 * 1024 },
}));

vi.mock('../../store', () => ({
  useAgenticStore: () => ({ apiClient: h.apiClient, logger: undefined }),
}));

import { useBatchTranscription } from '../useBatchTranscription';

const GATEWAY_LIMITS = {
  maxFilesPerBatch: 3,
  maxDurationMinutes: 30,
  maxFileSizeBytes: 100 * 1024 * 1024,
  maxActiveJobsPerUser: 3,
  allowedMimeTypes: ['audio/wav', 'audio/webm'],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.instances.length = 0;
  h.apiClient.get.mockResolvedValue(GATEWAY_LIMITS);
});

describe('limits', () => {
  it('adopts the gateway-resolved ceilings on mount', async () => {
    const { result } = renderHook(() => useBatchTranscription({ options: { pipelineId: 'p1' } }));

    await waitFor(() => expect(h.instances[0]!.setLimitsCalls.length).toBe(1));
    expect(h.apiClient.get).toHaveBeenCalledWith('/audio/transcription-jobs/limits');
    expect(h.instances[0]!.setLimitsCalls[0]).toMatchObject({ maxFilesPerBatch: 3, maxDurationMinutes: 30 });
    await waitFor(() => expect(result.current.limits.maxFilesPerBatch).toBe(3));
  });

  it('keeps the documented defaults when the limits fetch fails', async () => {
    // A settings/network hiccup must not block uploading — the gateway still
    // enforces the real ceiling on every request.
    h.apiClient.get.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useBatchTranscription({ options: { pipelineId: 'p1' } }));

    await waitFor(() => expect(result.current.limitsError).toBeInstanceOf(Error));
    expect(result.current.limits).toMatchObject({ maxFilesPerBatch: 5, maxDurationMinutes: 60 });
    expect(h.instances[0]!.setLimitsCalls).toHaveLength(0);
  });

  it('ignores a malformed limits payload rather than adopting garbage ceilings', async () => {
    h.apiClient.get.mockResolvedValue({ maxFilesPerBatch: 'five', maxDurationMinutes: -3 });
    const { result } = renderHook(() => useBatchTranscription({ options: { pipelineId: 'p1' } }));

    await waitFor(() => expect(h.apiClient.get).toHaveBeenCalled());
    expect(h.instances[0]!.setLimitsCalls[0] ?? {}).not.toHaveProperty('maxFilesPerBatch');
    expect(result.current.limits.maxFilesPerBatch).toBe(5);
  });
});

describe('queue lifecycle', () => {
  it('creates exactly one queue and keeps it across re-renders', async () => {
    const { rerender } = renderHook((props: { concurrency?: number } = {}) => useBatchTranscription({ options: { pipelineId: 'p1' }, ...props }));
    rerender({ concurrency: 4 });
    rerender({ concurrency: 4 });
    expect(h.instances).toHaveLength(1);
  });

  it('forwards changed upload defaults to the existing queue', async () => {
    const { rerender } = renderHook((props: { pipelineId: string }) => useBatchTranscription({ options: { pipelineId: props.pipelineId } }), {
      initialProps: { pipelineId: 'p1' },
    });
    rerender({ pipelineId: 'p2' });
    const calls = h.instances[0]!.setDefaultsCalls;
    expect(calls[calls.length - 1]).toMatchObject({ pipelineId: 'p2' });
  });

  it('disposes the queue on unmount so no stream outlives the screen', () => {
    const { unmount } = renderHook(() => useBatchTranscription({ options: { pipelineId: 'p1' } }));
    unmount();
    expect(h.instances[0]!.disposed).toBe(true);
  });

  it('re-renders when the engine emits new rows', async () => {
    const { result } = renderHook(() => useBatchTranscription({ options: { pipelineId: 'p1' } }));
    expect(result.current.items).toHaveLength(0);

    act(() => h.instances[0]!.push([{ id: 'a', status: 'processing' }]));
    expect(result.current.items).toHaveLength(1);
  });
});

describe('derived state', () => {
  function withItems(items: unknown[]) {
    const rendered = renderHook(() => useBatchTranscription({ options: { pipelineId: 'p1' } }));
    act(() => h.instances[0]!.push(items));
    return rendered;
  }

  it('reports uploading / processing / active counts separately', () => {
    const { result } = withItems([
      { id: 'a', status: 'uploading' },
      { id: 'b', status: 'processing' },
      { id: 'c', status: 'completed' },
      { id: 'd', status: 'pending' },
    ]);

    expect(result.current.isUploading).toBe(true);
    expect(result.current.isProcessing).toBe(true);
    expect(result.current.activeCount).toBe(2);
  });

  it('reports idle when nothing is in flight', () => {
    const { result } = withItems([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'failed' },
    ]);
    expect(result.current.isUploading).toBe(false);
    expect(result.current.isProcessing).toBe(false);
    expect(result.current.activeCount).toBe(0);
  });

  it('exposes remaining capacity so a picker can cap its own file input', () => {
    const { result } = withItems([
      { id: 'a', status: 'processing' },
      { id: 'b', status: 'completed' },
    ]);
    // 5 default − 2 counted rows.
    expect(result.current.remainingSlots).toBe(3);
  });

  it('never reports negative remaining capacity', () => {
    const { result } = withItems(Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, status: 'completed' })));
    expect(result.current.remainingSlots).toBe(0);
  });
});

describe('queue operations pass through to the engine', () => {
  it('delegates enqueue / cancel / retry / remove / clear', () => {
    const { result } = renderHook(() => useBatchTranscription({ options: { pipelineId: 'p1' } }));
    const file = new File(['x'], 'a.wav', { type: 'audio/wav' });

    act(() => {
      result.current.enqueue([file]);
      result.current.cancel('id-1');
      result.current.retry('id-2');
      result.current.remove('id-3');
      result.current.clear();
    });

    const queue = h.instances[0]!;
    expect(queue.enqueue).toHaveBeenCalledWith([file], undefined);
    expect(queue.cancel).toHaveBeenCalledWith('id-1');
    expect(queue.retry).toHaveBeenCalledWith('id-2');
    expect(queue.remove).toHaveBeenCalledWith('id-3');
    expect(queue.clear).toHaveBeenCalled();
  });
});
