/**
 * usePipelines.select(...) persistence — TASK-298 D-5
 *
 * Verifies that calling `select(id)` not only updates local state but also
 * persists the choice to the existing UserSettings backend via
 * `PATCH /user/me/settings/arcaai-sdk/selectedPipelineId`. The acceptance
 * criterion in TASK-298 §1.3 (6) requires that backend ownership of the
 * selected pipeline is enforced server-side (validator).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePipelines } from '../usePipelines';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { USER_SETTINGS_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('usePipelines.select — persistence (TASK-298 D-5)', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStore: any;
  const mockGet = vi.fn();
  const mockPatch = vi.fn();

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockGet.mockReset();
    mockPatch.mockReset();
    mockStore = {
      apiClient: { get: mockGet, post: vi.fn(), patch: mockPatch, delete: vi.fn() },
      logger: mockLogger,
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('issues PATCH /user/me/settings/arcaai-sdk/selectedPipelineId with the chosen id', async () => {
    const data = [
      { id: 'p-1', name: 'Default', slug: 'default' },
      { id: 'p-2', name: 'Fast', slug: 'fast' },
    ];
    mockGet.mockResolvedValue(data);
    mockPatch.mockResolvedValue({ id: 'setting-1', namespace: 'arcaai-sdk', key: 'selectedPipelineId', value: 'p-2' });

    const { result } = renderHook(() => usePipelines());

    await act(async () => {
      await result.current.list();
    });
    await act(async () => {
      await result.current.select('p-2');
    });

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        USER_SETTINGS_ENDPOINTS.updateByKey('arcaai-sdk', 'selectedPipelineId'),
        { value: 'p-2' },
      );
    });
  });

  it('updates local selectedPipeline immediately, before the PATCH resolves', async () => {
    const data = [{ id: 'p-A', name: 'A', slug: 'a' }];
    mockGet.mockResolvedValue(data);
    let resolvePatch: (v: unknown) => void = () => {};
    mockPatch.mockReturnValue(new Promise((res) => {
      resolvePatch = res;
    }));

    const { result } = renderHook(() => usePipelines());

    await act(async () => {
      await result.current.list();
    });

    act(() => {
      void result.current.select('p-A');
    });

    expect(result.current.selectedPipeline?.id).toBe('p-A');

    await act(async () => {
      resolvePatch({});
    });
  });

  it('still updates local state when the PATCH fails (does not throw)', async () => {
    const data = [{ id: 'p-1', name: 'Default', slug: 'default' }];
    mockGet.mockResolvedValue(data);
    mockPatch.mockRejectedValue(new Error('cross-tenant pipelineId'));

    const { result } = renderHook(() => usePipelines());

    await act(async () => {
      await result.current.list();
    });
    await act(async () => {
      await result.current.select('p-1');
    });

    expect(result.current.selectedPipeline?.id).toBe('p-1');
  });

  it('does not issue a PATCH when selecting an unknown pipeline id', async () => {
    const data = [{ id: 'p-1', name: 'Default', slug: 'default' }];
    mockGet.mockResolvedValue(data);

    const { result } = renderHook(() => usePipelines());

    await act(async () => {
      await result.current.list();
    });
    await act(async () => {
      await result.current.select('nonexistent');
    });

    expect(mockPatch).not.toHaveBeenCalled();
    expect(result.current.selectedPipeline).toBeNull();
  });
});
