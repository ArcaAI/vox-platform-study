/**
 * @arcaai/vox - useArcaSummary Hook (REFACTOR-01)
 *
 * Focused hook for summary generation and management.
 * Extracted from the useArca god hook for better performance and maintainability.
 */

import { useMemo, useCallback } from 'react';
import { useAgenticStore } from '../store';
import type {
  SummaryResponse,
  DNAStyle,
  AsyncJobResponse,
  ComprehensiveSummaryResponse,
  PaginationParams,
  UpdateSummaryOptions,
  SummaryVersionEntry,
  DiffResult,
} from '../types';
import type { SummaryApprovalResponse } from '../types/summary';
import type { SummaryGenerationOptions, ComprehensiveSummaryGenerationOptions } from '../types/summary';
import { SUMMARY_ENDPOINTS, CONTEXT_ENDPOINTS } from '../core/constants';
import { computeSummaryDiff } from '../utils/diffUtils';
import { withIdempotencyKey } from '../utils/idempotency';
import type { ISDKLogger } from '../core/logger';

/**
 * TASK-299 D-4 — Reconcile legacy SDK option field names to the canonical
 * backend DTO fields before POSTing. The backend's `GenerateSummaryRequest`
 * does NOT accept `transcript` / `promptTemplateId` / `departmentId`, so we
 * normalise them here and strip the legacy names from the body.
 */
function mapSummaryOptionsToBackend(options?: SummaryGenerationOptions): Record<string, unknown> | undefined {
  if (!options) return undefined;

  const { transcript, promptTemplateId, departmentId, transcription, template, options: optsBag, ...rest } = options;

  const out: Record<string, unknown> = { ...rest };
  const canonicalTranscription = transcription ?? transcript;
  const canonicalTemplate = template ?? promptTemplateId;

  if (canonicalTranscription !== undefined) out.transcription = canonicalTranscription;
  if (canonicalTemplate !== undefined) out.template = canonicalTemplate;

  if (departmentId !== undefined || optsBag !== undefined) {
    out.options = {
      ...(optsBag ?? {}),
      ...(departmentId !== undefined ? { departmentId } : {}),
    };
  }

  return out;
}

export type { UseArcaSummary } from './useArca';

export function useArcaSummary() {
  const store = useAgenticStore();

  const getLogger = useCallback((): ISDKLogger | undefined => {
    return store.logger?.child('useArcaSummary');
  }, [store.logger]);

  const generatePreSummary = useCallback(
    async (options?: SummaryGenerationOptions): Promise<SummaryResponse> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = getLogger()?.startOperation('generatePreSummary', {
        component: 'useArcaSummary',
        sdk: { consultationId: consultation.id },
      });

      store.setSummaryGenerating(true);
      store.setSummaryError(null);

      try {
        const mapped = mapSummaryOptionsToBackend(options);
        const body = mapped ? withIdempotencyKey(mapped, options?.idempotencyKey) : undefined;
        const summary = await apiClient.post<SummaryResponse>(SUMMARY_ENDPOINTS.PRE_SUMMARY(consultation.id), body);
        store.addSummary(summary);
        timer?.end(true, { attributes: { summaryId: summary.id } });
        return summary;
      } catch (error) {
        timer?.error(error as Error);
        store.setSummaryError(error as Error);
        throw error;
      } finally {
        store.setSummaryGenerating(false);
      }
    },
    [store, getLogger],
  );

  const generateSummary = useCallback(
    async (options?: SummaryGenerationOptions): Promise<SummaryResponse> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = getLogger()?.startOperation('generateSummary', {
        component: 'useArcaSummary',
        sdk: { consultationId: consultation.id },
      });

      store.setSummaryGenerating(true);
      store.setSummaryError(null);

      try {
        const mapped = mapSummaryOptionsToBackend(options);
        const body = mapped ? withIdempotencyKey(mapped, options?.idempotencyKey) : undefined;
        const summary = await apiClient.post<SummaryResponse>(SUMMARY_ENDPOINTS.GENERATE(consultation.id), body);
        store.addSummary(summary);
        timer?.end(true, { attributes: { summaryId: summary.id } });
        return summary;
      } catch (error) {
        timer?.error(error as Error);
        store.setSummaryError(error as Error);
        throw error;
      } finally {
        store.setSummaryGenerating(false);
      }
    },
    [store, getLogger],
  );

  const updateSummary = useCallback(
    async (id: string, content: string, options?: UpdateSummaryOptions): Promise<void> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = getLogger()?.startOperation('updateSummary', {
        component: 'useArcaSummary',
        sdk: { consultationId: consultation.id },
        attributes: { summaryId: id },
      });

      store.setSummaryGenerating(true);
      store.setSummaryError(null);

      try {
        await apiClient.patch(SUMMARY_ENDPOINTS.UPDATE(consultation.id, id), { content, ...options });
        timer?.end(true, { attributes: { contentLength: content.length } });
      } catch (error) {
        timer?.error(error as Error);
        store.setSummaryError(error as Error);
        throw error;
      } finally {
        store.setSummaryGenerating(false);
      }
    },
    [store, getLogger],
  );

  /** @deprecated Use the dedicated useDnaStyle hook for DNA operations. */
  const analyzeDNA = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Stub; use useDnaStyle; param kept for API compatibility.
    async (_texts: string[]): Promise<DNAStyle> => {
      getLogger()?.warn('analyzeDNA called on useArcaSummary; use useDnaStyle instead', {
        operation: 'analyzeDNA',
        component: 'useArcaSummary',
      });
      throw new Error('DNA analysis is available via the dedicated useDnaStyle hook, not useArcaSummary.analyzeDNA().');
    },
    [getLogger],
  );

  const loadSummaries = useCallback(
    async (pagination?: PaginationParams): Promise<SummaryResponse[]> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = getLogger()?.startOperation('loadSummaries', {
        component: 'useArcaSummary',
        sdk: { consultationId: consultation.id },
      });

      try {
        let url = SUMMARY_ENDPOINTS.LIST(consultation.id);
        if (pagination) {
          const params = new URLSearchParams();
          if (pagination.page != null) params.set('page', String(pagination.page));
          if (pagination.limit != null) params.set('limit', String(pagination.limit));
          const qs = params.toString();
          if (qs) url += `?${qs}`;
        }

        const summaries = await apiClient.get<SummaryResponse[]>(url);
        store.setSummaries(summaries);
        timer?.end(true, { attributes: { summaryCount: summaries.length } });
        return summaries;
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [store, getLogger],
  );

  const generateSummaryAsync = useCallback(
    async (options?: SummaryGenerationOptions): Promise<AsyncJobResponse> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      store.setSummaryGenerating(true);
      store.setSummaryError(null);

      try {
        const mapped = mapSummaryOptionsToBackend(options) ?? {};
        const body = withIdempotencyKey(mapped, options?.idempotencyKey);
        const job = await apiClient.post<AsyncJobResponse>(SUMMARY_ENDPOINTS.GENERATE_ASYNC(consultation.id), body);
        return job;
      } catch (error) {
        store.setSummaryError(error as Error);
        throw error;
      } finally {
        store.setSummaryGenerating(false);
      }
    },
    [store],
  );

  const generatePreSummaryAsync = useCallback(
    async (options?: SummaryGenerationOptions): Promise<AsyncJobResponse> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      store.setSummaryGenerating(true);
      store.setSummaryError(null);

      try {
        const mapped = mapSummaryOptionsToBackend(options) ?? {};
        const body = withIdempotencyKey(mapped, options?.idempotencyKey);
        const job = await apiClient.post<AsyncJobResponse>(SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC(consultation.id), body);
        return job;
      } catch (error) {
        store.setSummaryError(error as Error);
        throw error;
      } finally {
        store.setSummaryGenerating(false);
      }
    },
    [store],
  );

  const generateComprehensiveSummary = useCallback(
    async (options?: ComprehensiveSummaryGenerationOptions): Promise<ComprehensiveSummaryResponse> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      store.setSummaryGenerating(true);
      store.setSummaryError(null);

      try {
        const { idempotencyKey, ...rest } = options ?? {};
        const body = withIdempotencyKey(rest as Record<string, unknown>, idempotencyKey);
        const result = await apiClient.post<ComprehensiveSummaryResponse>(SUMMARY_ENDPOINTS.COMPREHENSIVE(consultation.id), body);
        return result;
      } catch (error) {
        store.setSummaryError(error as Error);
        throw error;
      } finally {
        store.setSummaryGenerating(false);
      }
    },
    [store],
  );

  const getLatestPreSummary = useCallback(async (): Promise<SummaryResponse> => {
    const { apiClient, consultation } = store;
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');

    return apiClient.get<SummaryResponse>(SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY(consultation.id));
  }, [store]);

  const getSummaryHistory = useCallback(
    async (summaryId: string): Promise<SummaryVersionEntry[]> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      return apiClient.get<SummaryVersionEntry[]>(SUMMARY_ENDPOINTS.VERSIONS(consultation.id, summaryId));
    },
    [store],
  );

  const compareSummaryVersions = useCallback(
    async (contextItemId: string, v1: number, v2: number): Promise<DiffResult> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const [version1, version2] = await Promise.all([
        apiClient.get<{ content: string }>(CONTEXT_ENDPOINTS.VERSION(consultation.id, contextItemId, v1)),
        apiClient.get<{ content: string }>(CONTEXT_ENDPOINTS.VERSION(consultation.id, contextItemId, v2)),
      ]);
      return computeSummaryDiff(version1.content, version2.content);
    },
    [store],
  );

  /**
   * Approve and lock a summary, preventing further edits.
   * Once approved, the summary status transitions to APPROVED → LOCKED.
   */
  const approveSummary = useCallback(
    async (contextItemId: string): Promise<SummaryApprovalResponse> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('approveSummary', {
        component: 'useArcaSummary',
        sdk: { consultationId: consultation.id },
        attributes: { contextItemId },
      });

      try {
        const result = await apiClient.post<SummaryApprovalResponse>(SUMMARY_ENDPOINTS.APPROVE(consultation.id, contextItemId), {});
        timer?.end(true);
        return result;
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [store, getLogger],
  );

  const latestSummary = store.summaries.find((s) => s.type === 'summary') ?? null;
  const latestPreSummary = store.summaries.find((s) => s.type === 'pre_summary') ?? null;

  return useMemo(
    () => ({
      preSummary: latestPreSummary,
      summary: latestSummary,
      all: store.summaries,
      dnaStyle: store.dnaStyle,
      isGenerating: store.summaryGenerating,
      error: store.summaryError,
      generatePreSummary,
      generateSummary,
      updateSummary,
      analyzeDNA,
      loadSummaries,
      generateSummaryAsync,
      generatePreSummaryAsync,
      generateComprehensiveSummary,
      getLatestPreSummary,
      getSummaryHistory,
      compareSummaryVersions,
      approveSummary,
    }),
    [
      latestPreSummary,
      latestSummary,
      store.summaries,
      store.dnaStyle,
      store.summaryGenerating,
      store.summaryError,
      generatePreSummary,
      generateSummary,
      updateSummary,
      analyzeDNA,
      loadSummaries,
      generateSummaryAsync,
      generatePreSummaryAsync,
      generateComprehensiveSummary,
      getLatestPreSummary,
      getSummaryHistory,
      compareSummaryVersions,
      approveSummary,
    ],
  );
}
