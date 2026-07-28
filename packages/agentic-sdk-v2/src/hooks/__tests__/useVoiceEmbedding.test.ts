/**
 * useVoiceEmbedding Hook Tests
 *
 * Rewritten against the real `/voice-profile` API.
 * Enrollment posts multipart via `apiClient.postFormData()`. Listing GETs
 * `/voice-profile`. Deletion targets `/voice-profile/:profileId` (profile id,
 * not user id).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useVoiceEmbedding } from '../useVoiceEmbedding';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { VOICE_EMBEDDING_ENDPOINTS } from '../../core/constants';
import { AgenticError } from '../../types/common';
import { SecureStorage } from '../../utils/secureStorage';

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
    // Hook needs userId + tenantId to scope SecureStorage cache.
    authUser: { id: 'user-1' },
    config: { api: { tenantId: 'tenant-1' } },
  };
}

describe('useVoiceEmbedding (voice-profile rewrite)', () => {
  let mockStore: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    // The hook hydrates profiles from a localStorage-backed SecureStorage
    // cache on mount. Clear it so cached profiles from a prior test cannot
    // leak into the next one (the per-package setup that normally does this
    // is not loaded under the single-project root config).
    localStorage.clear();
    mockStore = createMockStore();
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('returns empty profiles array and loading=false', () => {
      const { result } = renderHook(() => useVoiceEmbedding());
      expect(result.current.profiles).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isUploading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('enroll', () => {
    it('POSTs multipart via postFormData to VOICE_EMBEDDING_ENDPOINTS.enroll', async () => {
      const enrolled = { id: 'p-1', userId: 'u-1' };
      mockStore.apiClient.postFormData.mockResolvedValue(enrolled);
      const { result } = renderHook(() => useVoiceEmbedding());
      const audio = new Blob(['audio-data'], { type: 'audio/wav' });

      let resp: unknown;
      await act(async () => {
        resp = await result.current.enroll(audio);
      });

      expect(mockStore.apiClient.postFormData).toHaveBeenCalledOnce();
      const [endpoint, formData] = mockStore.apiClient.postFormData.mock.calls[0];
      expect(endpoint).toBe(VOICE_EMBEDDING_ENDPOINTS.enroll);
      expect(endpoint).toBe('/voice-profile/enroll');
      expect(formData).toBeInstanceOf(FormData);
      expect(resp).toEqual(enrolled);
    });

    it('does NOT call apiClient.post for enroll (multipart only)', async () => {
      mockStore.apiClient.postFormData.mockResolvedValue({ id: 'p-1' });
      const { result } = renderHook(() => useVoiceEmbedding());
      const audio = new Blob(['data'], { type: 'audio/wav' });

      await act(async () => {
        await result.current.enroll(audio);
      });

      expect(mockStore.apiClient.post).not.toHaveBeenCalled();
    });

    it('appends each provided file to the multipart form', async () => {
      mockStore.apiClient.postFormData.mockResolvedValue({ id: 'p-1' });
      const { result } = renderHook(() => useVoiceEmbedding());
      const a = new File(['a'], 'a.wav', { type: 'audio/wav' });
      const b = new File(['b'], 'b.wav', { type: 'audio/wav' });
      const c = new File(['c'], 'c.wav', { type: 'audio/wav' });

      await act(async () => {
        await result.current.enroll([a, b, c]);
      });

      const [, formData] = mockStore.apiClient.postFormData.mock.calls[0];
      const entries = (formData as FormData).getAll('files');
      expect(entries).toHaveLength(3);
    });

    it('sets error on failure and resets isUploading', async () => {
      mockStore.apiClient.postFormData.mockRejectedValue(new Error('Enroll failed'));
      const { result } = renderHook(() => useVoiceEmbedding());
      const audio = new Blob(['data'], { type: 'audio/wav' });

      await act(async () => {
        try {
          await result.current.enroll(audio);
        } catch {
          /* expected */
        }
      });

      expect(result.current.error?.message).toBe('Enroll failed');
      expect(result.current.isUploading).toBe(false);
    });

    it('throws the underlying error to the caller', async () => {
      mockStore.apiClient.postFormData.mockRejectedValue(new Error('boom'));
      const { result } = renderHook(() => useVoiceEmbedding());
      const audio = new Blob(['data'], { type: 'audio/wav' });

      await expect(
        act(async () => {
          await result.current.enroll(audio);
        }),
      ).rejects.toThrow('boom');
    });
  });

  describe('list', () => {
    it('GETs from VOICE_EMBEDDING_ENDPOINTS.list and updates profiles', async () => {
      const profiles = [{ id: 'p-1' }, { id: 'p-2' }];
      mockStore.apiClient.get.mockResolvedValue(profiles);
      const { result } = renderHook(() => useVoiceEmbedding());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.list();
      });

      expect(mockStore.apiClient.get).toHaveBeenCalledWith('/voice-profile');
      expect(result.current.profiles).toEqual(profiles);
      expect(resp).toEqual(profiles);
    });

    it('extracts array from paginated wrapper responses', async () => {
      const profiles = [{ id: 'p-1' }];
      mockStore.apiClient.get.mockResolvedValue({ data: profiles, count: 1 });
      const { result } = renderHook(() => useVoiceEmbedding());

      await act(async () => {
        await result.current.list();
      });

      expect(result.current.profiles).toEqual(profiles);
    });
  });

  describe('delete', () => {
    it('DELETEs by profileId, not userId', async () => {
      mockStore.apiClient.delete.mockResolvedValue(undefined);
      const { result } = renderHook(() => useVoiceEmbedding());

      await act(async () => {
        await result.current.delete('profile-abc');
      });

      expect(mockStore.apiClient.delete).toHaveBeenCalledWith('/voice-profile/profile-abc');
    });

    it('removes the deleted profile from the cached profiles list', async () => {
      mockStore.apiClient.get.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
      mockStore.apiClient.delete.mockResolvedValue(undefined);
      const { result } = renderHook(() => useVoiceEmbedding());

      await act(async () => {
        await result.current.list();
      });
      await act(async () => {
        await result.current.delete('p-1');
      });

      expect(result.current.profiles).toEqual([{ id: 'p-2' }]);
    });

    it('sets error on failure', async () => {
      mockStore.apiClient.delete.mockRejectedValue(new Error('Delete failed'));
      const { result } = renderHook(() => useVoiceEmbedding());

      await act(async () => {
        try {
          await result.current.delete('p-1');
        } catch {
          /* expected */
        }
      });

      expect(result.current.error?.message).toBe('Delete failed');
    });

    it('rethrows the underlying error to the caller', async () => {
      mockStore.apiClient.delete.mockRejectedValue(new Error('Delete failed'));
      const { result } = renderHook(() => useVoiceEmbedding());

      await expect(
        act(async () => {
          await result.current.delete('p-1');
        }),
      ).rejects.toThrow('Delete failed');
    });
  });

  describe('SDK not initialized', () => {
    it('throws on enroll when apiClient is null', async () => {
      (useAgenticStore as any).mockReturnValue({ apiClient: null, logger: null });
      const { result } = renderHook(() => useVoiceEmbedding());
      const audio = new Blob(['data'], { type: 'audio/wav' });

      await expect(
        act(async () => {
          await result.current.enroll(audio);
        }),
      ).rejects.toThrow('SDK not initialized');
    });

    it('throws on list when apiClient is null', async () => {
      (useAgenticStore as any).mockReturnValue({ apiClient: null, logger: null });
      const { result } = renderHook(() => useVoiceEmbedding());

      await expect(
        act(async () => {
          await result.current.list();
        }),
      ).rejects.toThrow('SDK not initialized');
    });

    it('throws on delete when apiClient is null', async () => {
      (useAgenticStore as any).mockReturnValue({ apiClient: null, logger: null });
      const { result } = renderHook(() => useVoiceEmbedding());

      await expect(
        act(async () => {
          await result.current.delete('p-1');
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });

  describe('null logger', () => {
    it('works correctly when store.logger is null', async () => {
      (useAgenticStore as any).mockReturnValue({ ...mockStore, logger: null });
      mockStore.apiClient.get.mockResolvedValue([]);
      const { result } = renderHook(() => useVoiceEmbedding());

      await act(async () => {
        await result.current.list();
      });
      expect(result.current.profiles).toEqual([]);
    });
  });

  describe('removed legacy surface', () => {
    it('does not expose upload/getStatus/remove/status/userId-based delete', () => {
      const { result } = renderHook(() => useVoiceEmbedding());
      // The new surface has enroll, list, delete only
      expect((result.current as any).upload).toBeUndefined();
      expect((result.current as any).getStatus).toBeUndefined();
      expect((result.current as any).remove).toBeUndefined();
      expect((result.current as any).status).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // Enroll opts.label
  // ------------------------------------------------------------------
  describe('enroll opts.label', () => {
    function audioFile(name = 'sample.wav'): File {
      return new File([new Uint8Array(8)], name, { type: 'audio/wav' });
    }

    it('appends label to FormData when opts.label is provided', async () => {
      mockStore.apiClient.postFormData.mockResolvedValue({ id: 'p-1' });
      const { result } = renderHook(() => useVoiceEmbedding());

      await act(async () => {
        await result.current.enroll(audioFile(), { label: 'doctor-mic' });
      });

      const [, formData] = mockStore.apiClient.postFormData.mock.calls[0];
      expect(formData.get('label')).toBe('doctor-mic');
    });

    it('does NOT append label when opts is omitted', async () => {
      mockStore.apiClient.postFormData.mockResolvedValue({ id: 'p-1' });
      const { result } = renderHook(() => useVoiceEmbedding());

      await act(async () => {
        await result.current.enroll(audioFile());
      });

      const [, formData] = mockStore.apiClient.postFormData.mock.calls[0];
      expect(formData.get('label')).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // Client-side MIME precheck
  // ------------------------------------------------------------------
  describe('MIME precheck', () => {
    it('throws AgenticError VALIDATION_ERROR when Blob has no type', async () => {
      const blob = new Blob([new Uint8Array(8)]);
      const { result } = renderHook(() => useVoiceEmbedding());

      await expect(result.current.enroll(blob)).rejects.toBeInstanceOf(AgenticError);
      expect(mockStore.apiClient.postFormData).not.toHaveBeenCalled();
    });

    it('throws AgenticError VALIDATION_ERROR when file type is not audio/*', async () => {
      const file = new File([new Uint8Array(8)], 'a.txt', { type: 'text/plain' });
      const { result } = renderHook(() => useVoiceEmbedding());

      await expect(result.current.enroll(file)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(mockStore.apiClient.postFormData).not.toHaveBeenCalled();
    });

    it('proceeds normally when file type starts with audio/', async () => {
      mockStore.apiClient.postFormData.mockResolvedValue({ id: 'p-1' });
      const file = new File([new Uint8Array(8)], 'a.wav', { type: 'audio/wav' });
      const { result } = renderHook(() => useVoiceEmbedding());

      await act(async () => {
        await result.current.enroll(file);
      });
      expect(mockStore.apiClient.postFormData).toHaveBeenCalledOnce();
    });
  });

  // ------------------------------------------------------------------
  // Activate
  // ------------------------------------------------------------------
  describe('activate', () => {
    it('PATCHes the activate endpoint and marks the profile active locally', async () => {
      mockStore.apiClient.get.mockResolvedValue([
        { id: 'p-1', isActive: false },
        { id: 'p-2', isActive: false },
      ]);
      mockStore.apiClient.patch.mockResolvedValue({ success: true });

      const { result } = renderHook(() => useVoiceEmbedding());

      await act(async () => {
        await result.current.list();
      });
      await act(async () => {
        await result.current.activate('p-1');
      });

      expect(mockStore.apiClient.patch).toHaveBeenCalledWith('/voice-profile/p-1/activate');
      expect(result.current.profiles).toEqual([
        { id: 'p-1', isActive: true },
        { id: 'p-2', isActive: false },
      ]);
    });

    it('uses VOICE_EMBEDDING_ENDPOINTS.activate factory', async () => {
      expect(VOICE_EMBEDDING_ENDPOINTS.activate('p-1')).toBe('/voice-profile/p-1/activate');
    });
  });

  // ------------------------------------------------------------------
  // Deactivate
  // ------------------------------------------------------------------
  describe('deactivate', () => {
    it('PATCHes the deactivate endpoint and marks the profile inactive locally', async () => {
      mockStore.apiClient.get.mockResolvedValue([
        { id: 'p-1', isActive: true },
        { id: 'p-2', isActive: false },
      ]);
      mockStore.apiClient.patch.mockResolvedValue({ success: true });

      const { result } = renderHook(() => useVoiceEmbedding());

      await act(async () => {
        await result.current.list();
      });
      await act(async () => {
        await result.current.deactivate('p-1');
      });

      expect(mockStore.apiClient.patch).toHaveBeenCalledWith('/voice-profile/p-1/deactivate');
      expect(result.current.profiles).toEqual([
        { id: 'p-1', isActive: false },
        { id: 'p-2', isActive: false },
      ]);
    });
  });

  // ------------------------------------------------------------------
  // SecureStorage cache
  // ------------------------------------------------------------------
  describe('SecureStorage cache', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('writes profiles to SecureStorage on list() success', async () => {
      const profiles = [{ id: 'p-1', isActive: true }];
      mockStore.apiClient.get.mockResolvedValue(profiles);
      const { result } = renderHook(() => useVoiceEmbedding());

      await act(async () => {
        await result.current.list();
      });

      await waitFor(async () => {
        const cached = await SecureStorage.getItemWithPassphrase('vox.voiceProfiles.user-1.tenant-1', 'vox-vp-user-1-tenant-1');
        expect(cached).not.toBeNull();
        expect(JSON.parse(cached!)).toEqual(profiles);
      });
    });

    it('hydrates profiles from SecureStorage on mount', async () => {
      const cached = [{ id: 'cached-1', isActive: true }];
      await SecureStorage.setItemWithPassphrase('vox.voiceProfiles.user-1.tenant-1', 'vox-vp-user-1-tenant-1', JSON.stringify(cached));

      mockStore.apiClient.get.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(cached), 100)));
      const { result } = renderHook(() => useVoiceEmbedding());

      await waitFor(() => {
        expect(result.current.profiles).toEqual(cached);
      });
    });

    it('writes updated profiles to SecureStorage after activate', async () => {
      mockStore.apiClient.get.mockResolvedValue([{ id: 'p-1', isActive: false }]);
      mockStore.apiClient.patch.mockResolvedValue({ success: true });
      const { result } = renderHook(() => useVoiceEmbedding());

      await act(async () => {
        await result.current.list();
      });
      await act(async () => {
        await result.current.activate('p-1');
      });

      await waitFor(async () => {
        const cached = await SecureStorage.getItemWithPassphrase('vox.voiceProfiles.user-1.tenant-1', 'vox-vp-user-1-tenant-1');
        expect(cached).not.toBeNull();
        expect(JSON.parse(cached!)).toEqual([{ id: 'p-1', isActive: true }]);
      });
    });

    it('skips cache when authUser is missing (no userId scope)', async () => {
      (useAgenticStore as any).mockReturnValue({ ...mockStore, authUser: null });
      mockStore.apiClient.get.mockResolvedValue([{ id: 'p-1' }]);
      const { result } = renderHook(() => useVoiceEmbedding());

      await act(async () => {
        await result.current.list();
      });

      const cached = localStorage.getItem('vox.voiceProfiles.user-1.tenant-1');
      expect(cached).toBeNull();
      expect(result.current.profiles).toEqual([{ id: 'p-1' }]);
    });
  });
});
