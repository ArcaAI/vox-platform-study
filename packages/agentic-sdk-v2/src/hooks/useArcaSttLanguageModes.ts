/**
 * @arcaai/vox - useArcaSttLanguageModes Hook (TASK-587)
 *
 * Fetches the backend-authoritative STT language-mode catalog
 * (`GET /audio/transcription-jobs/language-modes`) so a UI can render a
 * language picker. Each mode carries the catalog-wide set of engines that can
 * serve it, so a picker can indicate (or filter) which providers a mode fits.
 *
 * The selected mode id is passed to `audio.start({ languageMode })`; the
 * backend resolves it against the session engine and rejects (422) a mode no
 * configured engine can serve — "selection constrains providers".
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgenticStore } from '../store';
import { STT_ENDPOINTS } from '../core/constants';
import type { LanguageMode, LanguageModeCatalog } from '../types/stt';

export interface UseArcaSttLanguageModesReturn {
  /** The selectable language modes (empty until loaded / on error). */
  modes: LanguageMode[];
  isLoading: boolean;
  error: Error | null;
  /** Re-fetch the catalog. */
  refresh: () => Promise<void>;
}

/**
 * @param autoFetch - fetch once on mount (default `true`). Set `false` to fetch
 *   lazily via the returned `refresh()`.
 */
export function useArcaSttLanguageModes(autoFetch = true): UseArcaSttLanguageModesReturn {
  const store = useAgenticStore();
  const apiClient = store.apiClient;
  const logger = useMemo(() => store.logger?.child('useArcaSttLanguageModes'), [store.logger]);

  const [modes, setModes] = useState<LanguageMode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!apiClient) throw new Error('SDK not initialized');
    setIsLoading(true);
    setError(null);
    const timer = logger?.startOperation('refresh');
    try {
      const data = await apiClient.get<LanguageModeCatalog>(STT_ENDPOINTS.LANGUAGE_MODES);
      setModes(data?.modes ?? []);
      timer?.end(true);
    } catch (err) {
      setError(err as Error);
      timer?.error(err as Error);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, logger]);

  useEffect(() => {
    if (autoFetch && apiClient) {
      refresh().catch(() => {
        // error is surfaced via `error` state; swallow the rejection here.
      });
    }
  }, [autoFetch, apiClient, refresh]);

  return useMemo(() => ({ modes, isLoading, error, refresh }), [modes, isLoading, error, refresh]);
}
