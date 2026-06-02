/**
 * @arcaai/vox - useAudioRecordings Hook (TASK-329 P2 — dual-capture X8)
 *
 * Lists and attaches audio recordings on a consultation via the public
 * `/consultations/:id/recordings` routes. `add` accepts an optional
 * rawMediaId/processedMediaId pair (dual capture) and refreshes the cached
 * list on success.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { AUDIO_RECORDING_ENDPOINTS } from '../core/constants';
import type { AudioRecording, AddAudioRecordingInput, ContextItem } from '../types';

export interface UseAudioRecordingsReturn {
  recordings: AudioRecording[];
  isLoading: boolean;
  error: Error | null;
  /** List recordings attached to a consultation. */
  list: (consultationId: string) => Promise<AudioRecording[]>;
  /** Attach a recording (single or dual-capture); returns the audio container context item. */
  add: (consultationId: string, input: AddAudioRecordingInput) => Promise<ContextItem>;
}

export function useAudioRecordings(): UseAudioRecordingsReturn {
  const { execute, isLoading, error } = useApiOperation('useAudioRecordings');

  const [recordings, setRecordings] = useState<AudioRecording[]>([]);

  const list = useCallback(
    (consultationId: string): Promise<AudioRecording[]> =>
      execute<AudioRecording[]>('list', async (client) => {
        const data = await client.get<AudioRecording[]>(AUDIO_RECORDING_ENDPOINTS.LIST(consultationId));
        const next = data ?? [];
        setRecordings(next);
        return next;
      }),
    [execute],
  );

  const add = useCallback(
    (consultationId: string, input: AddAudioRecordingInput): Promise<ContextItem> =>
      execute<ContextItem>('add', async (client) => {
        const container = await client.post<ContextItem>(AUDIO_RECORDING_ENDPOINTS.ADD(consultationId), input);
        // Refresh the cached list so callers see the new recording immediately.
        const data = await client.get<AudioRecording[]>(AUDIO_RECORDING_ENDPOINTS.LIST(consultationId));
        setRecordings(data ?? []);
        return container;
      }),
    [execute],
  );

  return { recordings, isLoading, error, list, add };
}
