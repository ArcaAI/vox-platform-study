/**
 * @arcaai/vox - useDnaStyle Hook (SDK-207 WS-5)
 *
 * DNA Writing Style management hook for doctor-facing operations.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { DNA_STYLE_ENDPOINTS } from '../core/constants';
import type { DnaReport, DnaStyleVersion, DnaGenerateInput, DnaUpdateInput } from '../types';

export interface UseDnaStyleReturn {
  style: DnaReport | null;
  versions: DnaStyleVersion[];
  isLoading: boolean;
  error: Error | null;
  getMyStyle: () => Promise<DnaReport>;
  generate: (input?: DnaGenerateInput) => Promise<{ jobId: string }>;
  update: (reportId: string, input: DnaUpdateInput) => Promise<DnaReport>;
  getVersions: (reportId: string) => Promise<DnaStyleVersion[]>;
  getJobStatus: (jobId: string) => Promise<{ status: string; result?: DnaReport }>;
  pollJobStatus: (jobId: string, options?: { intervalMs?: number; maxAttempts?: number }) => Promise<DnaReport>;
  getByDoctor: (doctorId: string) => Promise<DnaReport>;
}

export function useDnaStyle(): UseDnaStyleReturn {
  const { execute, isLoading, error, apiClient, logger } = useApiOperation('useDnaStyle');

  const [style, setStyle] = useState<DnaReport | null>(null);
  const [versions, setVersions] = useState<DnaStyleVersion[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getMyStyle = useCallback(
    (): Promise<DnaReport> =>
      execute<DnaReport>('getMyStyle', async (client) => {
        const data = await client.get<DnaReport>(DNA_STYLE_ENDPOINTS.MY_STYLE);
        setStyle(data);
        return data;
      }),
    [execute],
  );

  const generate = useCallback(
    (input?: DnaGenerateInput): Promise<{ jobId: string }> =>
      execute<{ jobId: string }>('generate', (client) => client.post<{ jobId: string }>(DNA_STYLE_ENDPOINTS.GENERATE, input ?? {})),
    [execute],
  );

  const update = useCallback(
    (reportId: string, input: DnaUpdateInput): Promise<DnaReport> =>
      execute<DnaReport>('update', async (client) => {
        const data = await client.patch<DnaReport>(DNA_STYLE_ENDPOINTS.UPDATE(reportId), input);
        setStyle(data);
        return data;
      }),
    [execute],
  );

  const getVersions = useCallback(
    (reportId: string): Promise<DnaStyleVersion[]> =>
      execute<DnaStyleVersion[]>('getVersions', async (client) => {
        const raw = await client.get(DNA_STYLE_ENDPOINTS.VERSIONS(reportId));
        const items = extractArray<DnaStyleVersion>(raw);
        setVersions(items);
        return items;
      }),
    [execute],
  );

  const getJobStatus = useCallback(
    (jobId: string): Promise<{ status: string; result?: DnaReport }> =>
      execute<{ status: string; result?: DnaReport }>('getJobStatus', async (client) => {
        const data = await client.get<{ status: string; result?: DnaReport }>(DNA_STYLE_ENDPOINTS.JOB_STATUS(jobId));
        if (data.result) setStyle(data.result);
        return data;
      }),
    [execute],
  );

  const pollJobStatus = useCallback(
    async (jobId: string, options?: { intervalMs?: number; maxAttempts?: number }): Promise<DnaReport> => {
      if (!apiClient) throw new Error('SDK not initialized');
      const intervalMs = options?.intervalMs ?? 2000;
      const maxAttempts = options?.maxAttempts ?? 60;
      const timer = logger?.startOperation('pollJobStatus');

      return new Promise<DnaReport>((resolve, reject) => {
        let attempts = 0;
        const poll = async () => {
          attempts++;
          try {
            const data = await apiClient.get<{ status: string; result?: DnaReport }>(DNA_STYLE_ENDPOINTS.JOB_STATUS(jobId));

            if (data.status === 'completed' && data.result) {
              setStyle(data.result);
              timer?.end(true);
              resolve(data.result);
              return;
            }
            if (data.status === 'failed') {
              const err = new Error('DNA report generation failed');
              timer?.error(err);
              reject(err);
              return;
            }
            if (attempts >= maxAttempts) {
              const err = new Error('Polling exceeded max attempts');
              timer?.error(err);
              reject(err);
              return;
            }
            pollTimerRef.current = setTimeout(poll, intervalMs);
          } catch (err) {
            timer?.error(err as Error);
            reject(err);
          }
        };
        poll();
      });
    },
    [apiClient, logger],
  );

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const getByDoctor = useCallback(
    (doctorId: string): Promise<DnaReport> =>
      execute<DnaReport>('getByDoctor', async (client) => {
        const data = await client.get<DnaReport>(DNA_STYLE_ENDPOINTS.BY_DOCTOR(doctorId));
        setStyle(data);
        return data;
      }),
    [execute],
  );

  return {
    style,
    versions,
    isLoading,
    error,
    getMyStyle,
    generate,
    update,
    getVersions,
    getJobStatus,
    pollJobStatus,
    getByDoctor,
  };
}
