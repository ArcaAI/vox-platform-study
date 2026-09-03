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
  SummaryTag,
  CreateSummaryTagInput,
  VersionDiff,
} from '../types';
import type { SummaryApprovalResponse } from '../types/summary';
import type { SummaryGenerationOptions, ComprehensiveSummaryGenerationOptions } from '../types/summary';
import { SUMMARY_ENDPOINTS, CONTEXT_ENDPOINTS } from '../core/constants';
import { computeSummaryDiff } from '../utils/diffUtils';
import { withIdempotencyKey } from '../utils/idempotency';
import { ifMatchFor, requireExpectedVersion, toOccError, findSummaryVersion } from '../utils/occ';
import type { ISDKLogger } from '../core/logger';

/**
 * Reconcile legacy SDK option field names to the canonical
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

      // the route is `@RequiresIfMatch()` — send the strong
      // validator AND the body-field fallback, and surface 412 distinctly.
      const { expectedVersion: explicitVersion, ...changeOptions } = options ?? {};
      const expectedVersion = requireExpectedVersion(id, explicitVersion, findSummaryVersion(store.summaries, id));

      try {
        const updated = await apiClient.patchWithIfMatch<SummaryResponse>(
          SUMMARY_ENDPOINTS.UPDATE(consultation.id, id),
          { content, expectedVersion, ...changeOptions },
          ifMatchFor(expectedVersion),
        );
        if (updated) store.addSummary(updated);
        timer?.end(true, { attributes: { contentLength: content.length } });
      } catch (error) {
        const mapped = toOccError(error, id, expectedVersion);
        timer?.error(mapped as Error);
        store.setSummaryError(mapped as Error);
        throw mapped;
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
    async (contextItemId: string, options?: { expectedVersion?: number }): Promise<SummaryApprovalResponse> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const timer = logger?.startOperation('approveSummary', {
        component: 'useArcaSummary',
        sdk: { consultationId: consultation.id },
        attributes: { contextItemId },
      });

      // approve is a POST, so the If-Match header rides on
      // `postWithHeaders` (no POST-specific helper exists); the body carries
      // the same version as the documented fallback.
      const expectedVersion = requireExpectedVersion(contextItemId, options?.expectedVersion, findSummaryVersion(store.summaries, contextItemId));

      try {
        const result = await apiClient.postWithHeaders<SummaryApprovalResponse>(
          SUMMARY_ENDPOINTS.APPROVE(consultation.id, contextItemId),
          { expectedVersion },
          { 'If-Match': ifMatchFor(expectedVersion) },
        );
        timer?.end(true);
        return result;
      } catch (error) {
        const mapped = toOccError(error, contextItemId, expectedVersion);
        timer?.error(mapped as Error);
        throw mapped;
      }
    },
    [store, getLogger],
  );

  /**
   * Diff two summary versions via the backend `/diff`
   * endpoint. Returns the `from`/`to` snapshots ready for `VersionDiffPanel`.
   */
  const diffSummaryVersions = useCallback(
    async (contextItemId: string, from: number, to: number): Promise<VersionDiff> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      const url = `${SUMMARY_ENDPOINTS.DIFF(consultation.id, contextItemId)}?from=${from}&to=${to}`;
      return apiClient.get<VersionDiff>(url);
    },
    [store],
  );

  /** List the tags attached to a summary. */
  const getSummaryTags = useCallback(
    async (contextItemId: string): Promise<SummaryTag[]> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      return apiClient.get<SummaryTag[]>(SUMMARY_ENDPOINTS.TAGS(consultation.id, contextItemId));
    },
    [store],
  );

  /** Attach a tag to a summary. */
  const tagSummary = useCallback(
    async (contextItemId: string, input: CreateSummaryTagInput): Promise<SummaryTag> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      return apiClient.post<SummaryTag>(SUMMARY_ENDPOINTS.TAGS(consultation.id, contextItemId), input);
    },
    [store],
  );

  /** Remove a tag from a summary. */
  const deleteSummaryTag = useCallback(
    async (contextItemId: string, tagId: string): Promise<void> => {
      const { apiClient, consultation } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No active consultation');

      await apiClient.delete(SUMMARY_ENDPOINTS.TAG(consultation.id, contextItemId, tagId));
    },
    [store],
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
      diffSummaryVersions,
      getSummaryTags,
      tagSummary,
      deleteSummaryTag,
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
      diffSummaryVersions,
      getSummaryTags,
      tagSummary,
      deleteSummaryTag,
    ],
  );
}
