/**
 * @arcaai/vox - useVoiceEmbedding Hook (TASK-033)
 *
 * Manages speaker voice embeddings for personalized speaker recognition.
 */

import { useState, useMemo, useCallback } from 'react';
import { useAgenticStore } from '../store';
import { VOICE_EMBEDDING_ENDPOINTS } from '../core/constants';

export interface VoiceEmbeddingResponse {
  userId: string;
  speakerId: string;
  embeddingId: string;
  dimensions: number;
  createdAt: string;
  audioFileKey: string;
}

export interface VoiceEmbeddingStatus {
  userId: string;
  exists: boolean;
  createdAt?: string;
  dimensions?: number;
  audioFileKey?: string;
}

export interface UseVoiceEmbeddingReturn {
  status: VoiceEmbeddingStatus | null;
  isLoading: boolean;
  isUploading: boolean;
  error: Error | null;
  upload: (userId: string, audioFile: File | Blob) => Promise<VoiceEmbeddingResponse>;
  getStatus: (userId: string) => Promise<VoiceEmbeddingStatus>;
  remove: (userId: string) => Promise<void>;
}

export function useVoiceEmbedding(): UseVoiceEmbeddingReturn {
  const store = useAgenticStore();
  const apiClient = store.apiClient;
  const logger = useMemo(() => store.logger?.child('useVoiceEmbedding'), [store.logger]);

  const [status, setStatus] = useState<VoiceEmbeddingStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const upload = useCallback(
    async (userId: string, audioFile: File | Blob): Promise<VoiceEmbeddingResponse> => {
      if (!apiClient) throw new Error('SDK not initialized');
      setIsUploading(true);
      setError(null);
      const timer = logger?.startOperation('uploadVoiceEmbedding');
      try {
        const formData = new FormData();
        formData.append('file', audioFile);
        const data = await apiClient.post<VoiceEmbeddingResponse>(VOICE_EMBEDDING_ENDPOINTS.UPLOAD(userId), formData);
        setStatus({
          userId: data.userId,
          exists: true,
          dimensions: data.dimensions,
          createdAt: data.createdAt,
          audioFileKey: data.audioFileKey,
        });
        timer?.end(true);
        return data;
      } catch (err) {
        setError(err as Error);
        timer?.error(err as Error);
        throw err;
      } finally {
        setIsUploading(false);
      }
    },
    [apiClient, logger],
  );

  const getStatus = useCallback(
    async (userId: string): Promise<VoiceEmbeddingStatus> => {
      if (!apiClient) throw new Error('SDK not initialized');
      setIsLoading(true);
      setError(null);
      const timer = logger?.startOperation('getVoiceEmbeddingStatus');
      try {
        const data = await apiClient.get<VoiceEmbeddingStatus>(VOICE_EMBEDDING_ENDPOINTS.STATUS(userId));
        setStatus(data);
        timer?.end(true);
        return data;
      } catch (err) {
        setError(err as Error);
        timer?.error(err as Error);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [apiClient, logger],
  );

  const remove = useCallback(
    async (userId: string): Promise<void> => {
      if (!apiClient) throw new Error('SDK not initialized');
      setIsLoading(true);
      setError(null);
      const timer = logger?.startOperation('removeVoiceEmbedding');
      try {
        await apiClient.delete(VOICE_EMBEDDING_ENDPOINTS.REMOVE(userId));
        setStatus(null);
        timer?.end(true);
      } catch (err) {
        setError(err as Error);
        timer?.error(err as Error);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [apiClient, logger],
  );

  return useMemo(
    () => ({
      status,
      isLoading,
      isUploading,
      error,
      upload,
      getStatus,
      remove,
    }),
    [status, isLoading, isUploading, error, upload, getStatus, remove],
  );
}
