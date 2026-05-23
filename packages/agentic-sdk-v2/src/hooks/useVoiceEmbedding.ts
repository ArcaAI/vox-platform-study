/**
 * @arcaai/vox - useVoiceEmbedding Hook (TASK-265 W0-7 / GAP-02 rewrite)
 *
 * Targets the real `/voice-profile` API surface:
 *   POST   /voice-profile/enroll   (multipart, up to 3 files)
 *   GET    /voice-profile          (current user's profiles)
 *   DELETE /voice-profile/:id      (by profile id, not user id)
 *
 * Replaces the legacy `/users/:userId/voice-embedding` flow which 100% 404'd.
 * See docs/implementation/TASK-265-SDK-Endpoint-Drift/README.md.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { VOICE_EMBEDDING_ENDPOINTS } from '../core/constants';

export interface VoiceProfile {
  id: string;
  userId?: string;
  tenantId?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Permissive bag for fields the API may add over time. */
  [key: string]: unknown;
}

export type EnrollFiles = File | Blob | ReadonlyArray<File | Blob>;

export interface UseVoiceEmbeddingReturn {
  profiles: VoiceProfile[];
  isLoading: boolean;
  isUploading: boolean;
  error: Error | null;
  enroll: (files: EnrollFiles) => Promise<VoiceProfile>;
  list: () => Promise<VoiceProfile[]>;
  delete: (profileId: string) => Promise<void>;
}

export function useVoiceEmbedding(): UseVoiceEmbeddingReturn {
  const { execute, isLoading, error, apiClient } = useApiOperation('useVoiceEmbedding');
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const enroll = useCallback(
    async (files: EnrollFiles): Promise<VoiceProfile> => {
      if (!apiClient) throw new Error('SDK not initialized');
      const fileList: ReadonlyArray<File | Blob> = Array.isArray(files) ? (files as ReadonlyArray<File | Blob>) : [files as File | Blob];

      const formData = new FormData();
      for (const file of fileList) {
        formData.append('files', file);
      }

      setIsUploading(true);
      try {
        return await execute<VoiceProfile>(
          'enroll',
          (client) => client.postFormData<VoiceProfile>(VOICE_EMBEDDING_ENDPOINTS.enroll, formData),
          false,
        );
      } finally {
        setIsUploading(false);
      }
    },
    [apiClient, execute],
  );

  const listProfiles = useCallback(
    () =>
      execute<VoiceProfile[]>('list', async (client) => {
        const raw = await client.get(VOICE_EMBEDDING_ENDPOINTS.list);
        const items = extractArray<VoiceProfile>(raw);
        setProfiles(items);
        return items;
      }),
    [execute],
  );

  const deleteProfile = useCallback(
    (profileId: string) =>
      execute<void>('delete', async (client) => {
        await client.delete(VOICE_EMBEDDING_ENDPOINTS.delete(profileId));
        setProfiles((prev) => prev.filter((p) => p.id !== profileId));
      }),
    [execute],
  );

  return {
    profiles,
    isLoading,
    isUploading,
    error,
    enroll,
    list: listProfiles,
    delete: deleteProfile,
  };
}
