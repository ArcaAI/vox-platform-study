/**
 * useVoiceEnrollmentStatus Hook Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useVoiceEnrollmentStatus, createVoiceEnrollmentChecker } from '../useVoiceEnrollmentStatus';
import type { VoiceEnrollmentChecker } from '../useVoiceEnrollmentStatus';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

function createMockStore() {
  return {
    apiClient: {
      get: vi.fn(),
      post: vi.fn(),
      postFormData: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    logger: createMockLogger(),
    authUser: { id: 'user-1' },
    config: { api: { tenantId: 'tenant-1' } },
  };
}

describe('useVoiceEnrollmentStatus (TASK-296 C-4)', () => {
  let mockStore: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    mockStore = createMockStore();
    (useAgenticStore as any).mockReturnValue(mockStore);
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls list() on mount', async () => {
    mockStore.apiClient.get.mockResolvedValue([]);
    renderHook(() => useVoiceEnrollmentStatus());

    await waitFor(() => {
      expect(mockStore.apiClient.get).toHaveBeenCalledWith('/voice-profile');
    });
  });

  it('returns hasActive=true when at least one profile is active', async () => {
    mockStore.apiClient.get.mockResolvedValue([
      { id: 'p-1', isActive: false },
      { id: 'p-2', isActive: true },
    ]);
    const { result } = renderHook(() => useVoiceEnrollmentStatus());

    await waitFor(() => {
      expect(result.current.hasActive).toBe(true);
    });
    expect(result.current.profiles).toHaveLength(2);
  });

  it('returns hasActive=false when no profile is active', async () => {
    mockStore.apiClient.get.mockResolvedValue([
      { id: 'p-1', isActive: false },
      { id: 'p-2', isActive: false },
    ]);
    const { result } = renderHook(() => useVoiceEnrollmentStatus());

    await waitFor(() => {
      expect(result.current.profiles).toHaveLength(2);
    });
    expect(result.current.hasActive).toBe(false);
  });

  it('returns hasActive=false when no profiles exist', async () => {
    mockStore.apiClient.get.mockResolvedValue([]);
    const { result } = renderHook(() => useVoiceEnrollmentStatus());

    await waitFor(() => {
      expect(mockStore.apiClient.get).toHaveBeenCalled();
    });
    expect(result.current.hasActive).toBe(false);
  });

  describe('createVoiceEnrollmentChecker (TASK-300 hand-off)', () => {
    it('returns a VoiceEnrollmentChecker bound to an apiClient', async () => {
      const apiClient = {
        get: vi.fn().mockResolvedValue([{ id: 'p-1', isActive: true }]),
      };
      const checker: VoiceEnrollmentChecker = createVoiceEnrollmentChecker(apiClient as any);

      const hasActive = await checker.checkHasActiveProfile();

      expect(apiClient.get).toHaveBeenCalledWith('/voice-profile');
      expect(hasActive).toBe(true);
    });

    it('returns false when no active profile exists', async () => {
      const apiClient = {
        get: vi.fn().mockResolvedValue([{ id: 'p-1', isActive: false }]),
      };
      const checker = createVoiceEnrollmentChecker(apiClient as any);

      expect(await checker.checkHasActiveProfile()).toBe(false);
    });

    it('returns false on API error (fail-closed default)', async () => {
      const apiClient = {
        get: vi.fn().mockRejectedValue(new Error('Network')),
      };
      const checker = createVoiceEnrollmentChecker(apiClient as any);

      expect(await checker.checkHasActiveProfile()).toBe(false);
    });
  });
});
