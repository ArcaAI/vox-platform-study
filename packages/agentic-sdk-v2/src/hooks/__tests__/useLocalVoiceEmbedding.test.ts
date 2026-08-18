/**
 * useLocalVoiceEmbedding hook tests.
 *
 * The LOCAL provider:
 *   - extracts a speaker embedding in-browser via an injected (mocked) embedder
 *     — the heavy ONNX model never loads in tests,
 *   - persists the profile through the EXISTING enroll path (the mocked
 *     `useVoiceEmbedding().enroll` client → `POST /voice-profiles/enroll`),
 *   - caches the local embedding (tenant/user-namespaced) keyed to the returned
 *     profile id, and
 *   - "quick tests" a fresh clip via cosine similarity against the cache.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useLocalVoiceEmbedding } from '../useLocalVoiceEmbedding';
import { useAgenticStore } from '../../store/agenticStore';
import { SecureStorage } from '../../utils/secureStorage';
import type { LocalVoiceEmbedder } from '../../core/LocalVoiceEmbedder';

// ── mock the existing backend enroll client (the "enroll client") ──────
const mockBackendEnroll = vi.fn();
const mockBackendList = vi.fn();
vi.mock('../useVoiceEmbedding', () => ({
  useVoiceEmbedding: () => ({
    profiles: [],
    isLoading: false,
    isUploading: false,
    error: null,
    enroll: mockBackendEnroll,
    list: mockBackendList,
    activate: vi.fn(),
    deactivate: vi.fn(),
    delete: vi.fn(),
  }),
}));

// ── mock the store (userId + tenantId scope the embedding cache) ───────
vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

function mockStore() {
  return {
    apiClient: { get: vi.fn(), postFormData: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    logger: null,
    authUser: { id: 'user-1' },
    config: { api: { tenantId: 'tenant-1' } },
  };
}

// ── a fully-faked embedder (no transformers, no audio decode) ──────────
function fakeEmbedder(): LocalVoiceEmbedder & {
  load: ReturnType<typeof vi.fn>;
  embed: ReturnType<typeof vi.fn>;
  embedBlob: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  return {
    modelId: 'Xenova/wavlm-base-plus-sv',
    load: vi.fn(async () => {}),
    embed: vi.fn(async () => [1, 0, 0]),
    embedBlob: vi.fn(async () => [1, 0, 0]),
    dispose: vi.fn(() => {}),
  };
}

function audioFile(name = 'sample.wav'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'audio/wav' });
}

describe('useLocalVoiceEmbedding (LOCAL provider)', () => {
  beforeEach(() => {
    localStorage.clear();
    (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockStore());
    mockBackendEnroll.mockResolvedValue({ id: 'profile-1', userId: 'user-1', label: 'Doc Mic' });
  });

  afterEach(() => vi.clearAllMocks());

  it('reports whether local extraction is supported (boolean)', () => {
    const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder: fakeEmbedder() }));
    expect(typeof result.current.supported).toBe('boolean');
    expect(result.current.enrolled).toEqual([]);
    expect(result.current.status).toBe('idle');
  });

  describe('enroll', () => {
    it('persists via the EXISTING backend enroll client (POST /voice-profiles/enroll)', async () => {
      const embedder = fakeEmbedder();
      const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder }));

      const file = audioFile();
      await act(async () => {
        await result.current.enroll(file, { label: 'Doc Mic' });
      });

      expect(mockBackendEnroll).toHaveBeenCalledTimes(1);
      const [files, opts] = mockBackendEnroll.mock.calls[0];
      expect(files).toBe(file);
      expect(opts).toEqual({ label: 'Doc Mic' });
    });

    it('extracts a LOCAL embedding and caches it keyed to the returned profile id', async () => {
      const embedder = fakeEmbedder();
      const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder }));

      await act(async () => {
        await result.current.enroll(audioFile());
      });

      expect(embedder.embedBlob).toHaveBeenCalledTimes(1);
      expect(result.current.enrolled).toHaveLength(1);
      const record = result.current.enrolled[0];
      expect(record.profileId).toBe('profile-1');
      expect(record.embedding).toEqual([1, 0, 0]);
      expect(record.modelId).toBe('Xenova/wavlm-base-plus-sv');
      expect(record.dim).toBe(3);
    });

    it('pools (averages) multiple samples into one enrolled embedding', async () => {
      const embedder = fakeEmbedder();
      embedder.embedBlob.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 1, 0]);
      const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder }));

      await act(async () => {
        await result.current.enroll([audioFile('a.wav'), audioFile('b.wav')]);
      });

      expect(embedder.embedBlob).toHaveBeenCalledTimes(2);
      const record = result.current.enrolled[0];
      // centroid of [1,0,0] & [0,1,0] → L2-normalized [0.7071,0.7071,0]
      expect(record.embedding[0]).toBeCloseTo(Math.SQRT1_2, 5);
      expect(record.embedding[1]).toBeCloseTo(Math.SQRT1_2, 5);
    });

    it('returns the persisted VoiceProfile to the caller', async () => {
      const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder: fakeEmbedder() }));
      let profile: { id: string } | undefined;
      await act(async () => {
        profile = await result.current.enroll(audioFile());
      });
      expect(profile?.id).toBe('profile-1');
    });

    it('sets error status and does NOT cache when backend persistence fails', async () => {
      mockBackendEnroll.mockRejectedValueOnce(new Error('enroll 500'));
      const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder: fakeEmbedder() }));

      await act(async () => {
        await expect(result.current.enroll(audioFile())).rejects.toThrow('enroll 500');
      });

      expect(result.current.status).toBe('error');
      expect(result.current.error?.message).toBe('enroll 500');
      expect(result.current.enrolled).toEqual([]);
    });
  });

  describe('quickTest', () => {
    it('returns null when nothing has been enrolled locally', async () => {
      const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder: fakeEmbedder() }));
      let res: unknown;
      await act(async () => {
        res = await result.current.quickTest(audioFile('probe.wav'));
      });
      expect(res).toBeNull();
    });

    it('matches a probe clip against the enrolled embedding via cosine similarity', async () => {
      const embedder = fakeEmbedder();
      embedder.embedBlob.mockResolvedValueOnce([1, 0, 0]); // enroll
      const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder }));

      await act(async () => {
        await result.current.enroll(audioFile('enroll.wav'));
      });

      embedder.embedBlob.mockResolvedValueOnce([0.96, 0.04, 0]); // probe (same speaker)
      let res: { profileId: string; isMatch: boolean; score: number } | null = null;
      await act(async () => {
        res = await result.current.quickTest(audioFile('probe.wav'));
      });

      expect(res).not.toBeNull();
      expect(res!.profileId).toBe('profile-1');
      expect(res!.isMatch).toBe(true);
      expect(res!.score).toBeGreaterThan(0.85);
    });

    it('reports no-match for a dissimilar probe clip', async () => {
      const embedder = fakeEmbedder();
      embedder.embedBlob.mockResolvedValueOnce([1, 0, 0]); // enroll
      const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder }));

      await act(async () => {
        await result.current.enroll(audioFile('enroll.wav'));
      });

      embedder.embedBlob.mockResolvedValueOnce([0, 0, 1]); // orthogonal → different speaker
      let res: { isMatch: boolean } | null = null;
      await act(async () => {
        res = await result.current.quickTest(audioFile('probe.wav'));
      });

      expect(res!.isMatch).toBe(false);
    });
  });

  describe('tenant/user-namespaced cache', () => {
    it('persists the enrolled embedding to namespaced SecureStorage', async () => {
      const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder: fakeEmbedder() }));
      await act(async () => {
        await result.current.enroll(audioFile());
      });

      await waitFor(async () => {
        const cached = await SecureStorage.getItemWithPassphrase('vox.localVoiceEmbeddings.user-1.tenant-1', 'vox-lve-user-1-tenant-1');
        expect(cached).not.toBeNull();
        const parsed = JSON.parse(cached!);
        expect(parsed[0].profileId).toBe('profile-1');
        expect(parsed[0].embedding).toEqual([1, 0, 0]);
      });
    });

    it('hydrates enrolled embeddings from the namespaced cache on mount', async () => {
      const seeded = [
        {
          profileId: 'seed-1',
          label: 'Seeded',
          modelId: 'Xenova/wavlm-base-plus-sv',
          dim: 3,
          embedding: [1, 0, 0],
          createdAt: new Date().toISOString(),
        },
      ];
      await SecureStorage.setItemWithPassphrase('vox.localVoiceEmbeddings.user-1.tenant-1', 'vox-lve-user-1-tenant-1', JSON.stringify(seeded));

      const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder: fakeEmbedder() }));

      await waitFor(() => {
        expect(result.current.enrolled).toHaveLength(1);
        expect(result.current.enrolled[0].profileId).toBe('seed-1');
      });
    });

    it('clearLocal() empties the cache and the enrolled list', async () => {
      const { result } = renderHook(() => useLocalVoiceEmbedding({ embedder: fakeEmbedder() }));
      await act(async () => {
        await result.current.enroll(audioFile());
      });
      expect(result.current.enrolled).toHaveLength(1);

      await act(async () => {
        await result.current.clearLocal();
      });
      expect(result.current.enrolled).toEqual([]);
      const cached = localStorage.getItem('vox.localVoiceEmbeddings.user-1.tenant-1');
      expect(cached).toBeNull();
    });
  });
});
