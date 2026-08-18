/**
 * @arcaai/vox - useVoiceEmbedding Hook
 *
 * Targets the real `/voice-profiles` API surface:
 *   POST   /voice-profiles/enroll              (multipart, up to 3 files)
 *   GET    /voice-profiles                    (current user's profiles)
 *   DELETE /voice-profiles/:id                 (by profile id, not user id)
 *   PATCH  /voice-profiles/:id/activate
 *   PATCH  /voice-profiles/:id/deactivate
 *
 * Replaces the legacy `/users/:userId/voice-embedding` flow which 100% 404'd.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { VOICE_EMBEDDING_ENDPOINTS } from '../core/constants';
import { useAgenticStore } from '../store';
import { SecureStorage } from '../utils/secureStorage';
import { AgenticError } from '../types/common';

export interface VoiceProfile {
  id: string;
  userId?: string;
  tenantId?: string;
  isActive?: boolean;
  label?: string | null;
  modelId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** Permissive bag for fields the API may add over time. */
  [key: string]: unknown;
}

export type EnrollFiles = File | Blob | ReadonlyArray<File | Blob>;

export interface EnrollOptions {
  /** Optional human-readable label persisted on the profile row (forwarded as form field). */
  label?: string;
}

export interface UseVoiceEmbeddingReturn {
  profiles: VoiceProfile[];
  isLoading: boolean;
  isUploading: boolean;
  error: Error | null;
  enroll: (files: EnrollFiles, opts?: EnrollOptions) => Promise<VoiceProfile>;
  list: () => Promise<VoiceProfile[]>;
  activate: (profileId: string) => Promise<void>;
  deactivate: (profileId: string) => Promise<void>;
  delete: (profileId: string) => Promise<void>;
}

/**
 * Namespace cache keys per (userId, tenantId) so logout / tenant
 * switch evicts the cache automatically. Passphrase is non-PHI and stable per
 * (user, tenant) — only used to derive a localStorage encryption key for
 * defence-in-depth (the cached payload is just metadata, no embeddings).
 */
function getCacheKeys(userId: string | null | undefined, tenantId: string | null | undefined) {
  if (!userId || !tenantId) return null;
  return {
    storageKey: `vox.voiceProfiles.${userId}.${tenantId}`,
    passphrase: `vox-vp-${userId}-${tenantId}`,
  };
}

async function writeCache(cacheKeys: { storageKey: string; passphrase: string } | null, profiles: VoiceProfile[]): Promise<void> {
  if (!cacheKeys) return;
  try {
    await SecureStorage.setItemWithPassphrase(cacheKeys.storageKey, cacheKeys.passphrase, JSON.stringify(profiles));
  } catch {
    // Best-effort cache write — never propagate failure to the caller.
  }
}

function normalizeFiles(files: EnrollFiles): ReadonlyArray<File | Blob> {
  if (Array.isArray(files)) return files as ReadonlyArray<File | Blob>;
  return [files as File | Blob];
}

/**
 * Refuse non-audio inputs at the SDK boundary so the user gets
 * a friendly error instead of an opaque 400 from `FileTypeValidator`.
 */
function assertAllAudio(fileList: ReadonlyArray<File | Blob>): void {
  for (const f of fileList) {
    const type = (f as File).type ?? '';
    if (!type || !type.startsWith('audio/')) {
      throw new AgenticError('VALIDATION_ERROR', 'Voice sample must be an audio file', {
        context: { receivedType: type || '(empty)' },
      });
    }
  }
}

export function useVoiceEmbedding(): UseVoiceEmbeddingReturn {
  const { execute, isLoading, error, apiClient } = useApiOperation('useVoiceEmbedding');
  const store = useAgenticStore();
  const userId = (store as unknown as { authUser?: { id?: string } | null }).authUser?.id ?? null;
  const tenantId = (store as unknown as { config?: { api?: { tenantId?: string } } | null }).config?.api?.tenantId ?? null;
  // Stable across renders for the same (userId, tenantId) tuple, so downstream
  // useCallback identities don't churn — guards against infinite re-render loops
  // when a consumer (e.g. useVoiceEnrollmentStatus) depends on list().
  const cacheKeys = useMemo(() => getCacheKeys(userId, tenantId), [userId, tenantId]);

  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  // Mirror of `profiles` so mutation callbacks (activate/deactivate/delete)
  // can compute the next state synchronously without relying on setState
  // updater closures (which React may invoke twice in dev/StrictMode).
  const profilesRef = useRef<VoiceProfile[]>([]);
  const applyProfiles = useCallback((next: VoiceProfile[]) => {
    profilesRef.current = next;
    setProfiles(next);
  }, []);

  // Hydrate from SecureStorage on mount (stale-while-revalidate).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current || !cacheKeys) return;
    hydratedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const cached = await SecureStorage.getItemWithPassphrase(cacheKeys.storageKey, cacheKeys.passphrase);
        if (cached && !cancelled) {
          const parsed = JSON.parse(cached) as VoiceProfile[];
          if (Array.isArray(parsed)) {
            applyProfiles(parsed);
          }
        }
      } catch {
        // Cache hydration is best-effort; on failure we fall through to list().
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cacheKeys?.storageKey, cacheKeys?.passphrase, applyProfiles]);

  const enroll = useCallback(
    async (files: EnrollFiles, opts?: EnrollOptions): Promise<VoiceProfile> => {
      if (!apiClient) throw new Error('SDK not initialized');

      const fileList = normalizeFiles(files);
      assertAllAudio(fileList);

      const formData = new FormData();
      for (const file of fileList) {
        formData.append('files', file);
      }
      if (opts?.label) {
        formData.append('label', opts.label);
      }

      setIsUploading(true);
      try {
        const enrolled = await execute<VoiceProfile>(
          'enroll',
          (client) => client.postFormData<VoiceProfile>(VOICE_EMBEDDING_ENDPOINTS.enroll, formData),
          false,
        );
        const next = [...profilesRef.current, enrolled];
        applyProfiles(next);
        await writeCache(cacheKeys, next);
        return enrolled;
      } finally {
        setIsUploading(false);
      }
    },
    [apiClient, execute, cacheKeys, applyProfiles],
  );

  const listProfiles = useCallback(
    () =>
      execute<VoiceProfile[]>('list', async (client) => {
        const raw = await client.get(VOICE_EMBEDDING_ENDPOINTS.list);
        const items = extractArray<VoiceProfile>(raw);
        applyProfiles(items);
        await writeCache(cacheKeys, items);
        return items;
      }),
    [execute, cacheKeys, applyProfiles],
  );

  const activate = useCallback(
    (profileId: string) =>
      execute<void>('activate', async (client) => {
        await client.patch(VOICE_EMBEDDING_ENDPOINTS.activate(profileId));
        const next = profilesRef.current.map((p) => ({ ...p, isActive: p.id === profileId }));
        applyProfiles(next);
        await writeCache(cacheKeys, next);
      }),
    [execute, cacheKeys, applyProfiles],
  );

  const deactivate = useCallback(
    (profileId: string) =>
      execute<void>('deactivate', async (client) => {
        await client.patch(VOICE_EMBEDDING_ENDPOINTS.deactivate(profileId));
        const next = profilesRef.current.map((p) => (p.id === profileId ? { ...p, isActive: false } : p));
        applyProfiles(next);
        await writeCache(cacheKeys, next);
      }),
    [execute, cacheKeys, applyProfiles],
  );

  const deleteProfile = useCallback(
    (profileId: string) =>
      execute<void>('delete', async (client) => {
        await client.delete(VOICE_EMBEDDING_ENDPOINTS.delete(profileId));
        const next = profilesRef.current.filter((p) => p.id !== profileId);
        applyProfiles(next);
        await writeCache(cacheKeys, next);
      }),
    [execute, cacheKeys, applyProfiles],
  );

  return {
    profiles,
    isLoading,
    isUploading,
    error,
    enroll,
    list: listProfiles,
    activate,
    deactivate,
    delete: deleteProfile,
  };
}
