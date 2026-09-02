/**
 * @arcaai/vox - useArcaSession Hook
 *
 * Simplified session management hook.
 *
 * Key features:
 * - Single `open()` for get-or-create workflow
 * - No pause/resume/end lifecycle management
 * - Simplified cross-tab sync using BroadcastChannel
 * - Patient history support
 */

import { useMemo, useCallback, useEffect, useRef } from 'react';
import { useAgenticStore } from '../store';
import type {
  Consultation,
  OpenSessionInput,
  SessionState,
  SessionActions,
  AddContextInput,
  ContextItem,
  SummaryResponse,
  UpdateConsultationInput,
} from '../types';
import { CONSULTATION_ENDPOINTS, CONTEXT_ENDPOINTS, SUMMARY_ENDPOINTS } from '../core/constants';
import { SimpleCrossTabSync, createCrossTabSync } from '../core/SimpleCrossTabSync';
import type { ISDKLogger } from '../core/logger';
import { openSessionOperation, loadConsultationOperation, getPatientHistoryOperation } from '../core/sessionUtils';
import { AgenticError } from '../types';
import { ifMatchFor, toOccError } from '../utils/occ';
// Client-side payload validation against the session-pinned schema.
import { validateConsultationContextPayload } from '../core/contextPayloadValidation';

// =============================================================================
// Return Type
// =============================================================================

export interface UseArcaSessionReturn extends SessionState, SessionActions {
  /** Load summaries for the current consultation from backend (HOOK-06) */
  loadSummaries: () => Promise<SummaryResponse[]>;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Session management hook
 *
 * @example
 * ```tsx
 * function ConsultationPage({ patientId }: { patientId: string }) {
 *   const session = useArcaSession();
 *
 *   useEffect(() => {
 *     // Open session when page loads
 *     session.open({ patientId });
 *   }, [patientId]);
 *
 *   if (session.isLoading) return <Loading />;
 *   if (!session.consultation) return null;
 *
 *   return (
 *     <div>
 *       <ContextList items={session.context} />
 *       <button onClick={() => session.addContext({
 *         type: 'CASE_NOTE',
 *         content: 'Patient reports...',
 *       })}>
 *         Add Note
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useArcaSession(): UseArcaSessionReturn {
  const store = useAgenticStore();
  const crossTabSyncRef = useRef<SimpleCrossTabSync | null>(null);

  // Get logger from store
  const getLogger = useCallback((): ISDKLogger | undefined => {
    return store.logger?.child('useArcaSession');
  }, [store.logger]);

  // Clean up cross-tab sync on unmount
  useEffect(() => {
    return () => {
      if (crossTabSyncRef.current) {
        crossTabSyncRef.current.close();
        crossTabSyncRef.current = null;
      }
    };
  }, []);

  const setupCrossTabSync = useCallback(
    (consultation: Consultation) => {
      if (crossTabSyncRef.current) {
        crossTabSyncRef.current.close();
      }
      // Namespace the cross-tab channel per tenant
      // (`agentic.<tenantId>`) so context never bleeds across tenants sharing
      // an origin. Resolve the active tenant from the api client.
      const tenantId = store.apiClient?.getTenantId();
      crossTabSyncRef.current = createCrossTabSync(
        {
          patientId: consultation.patientId,
          doctorId: consultation.doctorId,
          appointmentDate: consultation.appointmentDate,
        },
        { tenantId },
      );
      crossTabSyncRef.current.onContextAdded((context) => {
        store.addContextItem(context as ContextItem);
      });
    },
    [store],
  );

  /**
   * Open a consultation session (get-or-create).
   * Delegates core logic to shared sessionUtils (REFACTOR-02).
   */
  const open = useCallback(
    async (input: OpenSessionInput): Promise<Consultation> => {
      const { apiClient } = store;
      if (!apiClient) throw new Error('SDK not initialized');

      const consultation = await openSessionOperation(apiClient, store, getLogger(), input);
      setupCrossTabSync(consultation);
      return consultation;
    },
    [store, getLogger, setupCrossTabSync],
  );

  /**
   * Add context to the current consultation.
   *
   * When `input.kindKey` + `input.payload` are both present, the
   * payload is validated CLIENT-SIDE against the session's pinned schema
   * bundle BEFORE the request is sent — a fast-fail UX aid, never the source
   * of truth (see `validateConsultationContextPayload`'s doc comment: an
   * unrecognized `kindKey` is treated as "nothing to validate against, let
   * the server decide", not a client-side error). Every write also carries
   * `X-Context-Schema-Version` when a schema is pinned, so the server
   * validates against the EXACT version this client built against
   * Rather than whatever the tenant has since published.
   */
  const addContext = useCallback(
    async (input: AddContextInput): Promise<ContextItem> => {
      const { apiClient, consultation, consultationSchema } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No consultation open. Call open() first.');

      const timer = logger?.startOperation('addContext', {
        component: 'useArcaSession',
        sdk: { consultationId: consultation.id },
        attributes: { type: input.type, kindKey: input.kindKey },
      });

      if (input.kindKey && input.payload !== undefined) {
        const { valid, problems } = validateConsultationContextPayload(consultationSchema, input.kindKey, input.payload);
        if (!valid) {
          const validationError = new AgenticError(
            'VALIDATION_ERROR',
            `Context payload for kind "${input.kindKey}" failed client-side schema validation: ${problems.join('; ')}`,
            { context: { kindKey: input.kindKey, problems } },
          );
          timer?.error(validationError);
          throw validationError;
        }
      }

      const pinnedSchemaVersionId = consultationSchema?.contextSchemaVersionId ?? undefined;

      // `structuredData` is not a field the gateway declares — a body carrying
      // it is rejected wholesale by `forbidNonWhitelisted`.
      // Fold the deprecated alias into the declared `metadata` field so callers
      // written against the old shape start working rather than silently 400ing.
      const { structuredData, ...rest } = input;
      const body = structuredData ? { ...rest, metadata: { ...structuredData, ...(input.metadata ?? {}) } } : rest;

      try {
        const contextItem = pinnedSchemaVersionId
          ? await apiClient.postWithHeaders<ContextItem>(CONTEXT_ENDPOINTS.ADD(consultation.id), body, {
              'X-Context-Schema-Version': pinnedSchemaVersionId,
            })
          : await apiClient.post<ContextItem>(CONTEXT_ENDPOINTS.ADD(consultation.id), body);

        // Add to local store
        store.addContextItem(contextItem);

        // Broadcast to other tabs
        if (crossTabSyncRef.current) {
          crossTabSyncRef.current.broadcastContext(contextItem);
        }

        timer?.end(true, {
          attributes: { contextItemId: contextItem.id },
        });

        return contextItem;
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [store, getLogger],
  );

  /**
   * Get shared context from all doctors on the same date
   */
  const getSharedContext = useCallback(async (): Promise<ContextItem[]> => {
    const { apiClient, consultation } = store;
    const logger = getLogger();
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No consultation open. Call open() first.');

    logger?.debug('Getting shared context', {
      operation: 'getSharedContext',
      component: 'useArcaSession',
      sdk: { consultationId: consultation.id },
    });

    const sharedContext = await apiClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.SHARED(consultation.id));

    // Update store with shared context
    store.setSharedContext(sharedContext);

    return sharedContext;
  }, [store, getLogger]);

  /**
   * Get patient consultation history.
   * Delegates to shared sessionUtils (REFACTOR-02).
   */
  const getPatientHistory = useCallback(
    async (patientId: string): Promise<Consultation[]> => {
      const { apiClient } = store;
      if (!apiClient) throw new Error('SDK not initialized');
      return getPatientHistoryOperation(apiClient, getLogger(), patientId);
    },
    [store, getLogger],
  );

  /**
   * Load a specific consultation (for viewing history).
   * Delegates core logic to shared sessionUtils (REFACTOR-02).
   */
  const loadConsultation = useCallback(
    async (consultationId: string): Promise<Consultation> => {
      const { apiClient } = store;
      if (!apiClient) throw new Error('SDK not initialized');

      const consultation = await loadConsultationOperation(apiClient, store, getLogger(), consultationId);
      setupCrossTabSync(consultation);
      return consultation;
    },
    [store, getLogger, setupCrossTabSync],
  );

  /**
   * Update the current consultation (department / status / metadata) (SES-02).
   */
  const update = useCallback(
    async (input: UpdateConsultationInput): Promise<Consultation> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No consultation open. Call open() first.');

      const timer = logger?.startOperation('update', {
        component: 'useArcaSession',
        sdk: { consultationId: consultation.id },
      });

      // `PATCH /consultations/:id` is `@RequiresIfMatch()`. Echo the strong
      // validator the SDK read with this consultation; when the loaded row
      // carries no `version` we send NO precondition rather than inventing
      // one — a 428 that names the missing header beats a fabricated CAS.
      const expectedVersion = consultation.version;

      try {
        const updated =
          typeof expectedVersion === 'number'
            ? await apiClient.patchWithIfMatch<Consultation>(CONSULTATION_ENDPOINTS.UPDATE(consultation.id), input, ifMatchFor(expectedVersion))
            : await apiClient.patch<Consultation>(CONSULTATION_ENDPOINTS.UPDATE(consultation.id), input);
        store.setConsultation(updated);
        timer?.end(true);
        return updated;
      } catch (error) {
        // Surface a stale write as a refetch-and-retry conflict rather than a
        // generic failure (same shape the context/summary writes already use).
        const mapped = typeof expectedVersion === 'number' ? toOccError(error, consultation.id, expectedVersion) : error;
        timer?.error(mapped as Error);
        throw mapped;
      }
    },
    [store, getLogger],
  );

  /**
   * Shared body of the three session-state transitions (TASK-858 G1).
   *
   * `POST :id/prime`, `:id/close` and `:id/reopen` all carry
   * `@RequiresIfMatch()` + `@ExpectedVersion()` on the gateway, so a
   * validator-less request answers `428 Precondition Required` — which is what
   * a bare `apiClient.post(...)` produced for every one of them. The header
   * rides on `postWithHeaders` (the house POST + If-Match helper, as in
   * `useArcaSummary.approveSummary`); there is no POST-specific OCC wrapper.
   *
   * Same two rules `update()` follows: when the loaded row carries no
   * `version` we send NO precondition rather than inventing one (a 428 naming
   * the missing header beats a fabricated CAS), and a `412` surfaces as a
   * typed `ConfigConflictError` so the caller can re-fetch and retry rather
   * than seeing a generic failure. The 200 response replaces the stored
   * consultation, so the NEXT transition sends the refreshed validator.
   */
  const transitionState = useCallback(
    async (operation: 'prime' | 'close' | 'reopen', endpoint: (id: string) => string): Promise<Consultation> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No consultation open. Call open() first.');

      const timer = logger?.startOperation(operation, {
        component: 'useArcaSession',
        sdk: { consultationId: consultation.id },
      });

      const expectedVersion = consultation.version;

      try {
        const updated =
          typeof expectedVersion === 'number'
            ? await apiClient.postWithHeaders<Consultation>(endpoint(consultation.id), {}, { 'If-Match': ifMatchFor(expectedVersion) })
            : await apiClient.post<Consultation>(endpoint(consultation.id), {});
        store.setConsultation(updated);
        timer?.end(true);
        return updated;
      } catch (error) {
        const mapped = typeof expectedVersion === 'number' ? toOccError(error, consultation.id, expectedVersion) : error;
        timer?.error(mapped as Error);
        throw mapped;
      }
    },
    [store, getLogger],
  );

  /**
   * Prime the current consultation — the session state machine's first
   * checkpoint (and the gateway's AI_DOCUMENTATION consent checkpoint).
   */
  const prime = useCallback((): Promise<Consultation> => transitionState('prime', CONSULTATION_ENDPOINTS.PRIME), [transitionState]);

  /**
   * Close the current consultation (transition status to CLOSED).
   */
  const close = useCallback((): Promise<Consultation> => transitionState('close', CONSULTATION_ENDPOINTS.CLOSE), [transitionState]);

  /**
   * Reopen a previously closed consultation (transition status to OPEN).
   */
  const reopen = useCallback((): Promise<Consultation> => transitionState('reopen', CONSULTATION_ENDPOINTS.REOPEN), [transitionState]);

  /**
   * Load all summaries for the current consultation from backend.
   * HOOK-06: Ensures summaries are available after page refresh or load.
   */
  const loadSummaries = useCallback(async (): Promise<SummaryResponse[]> => {
    const { apiClient, consultation } = store;
    const logger = getLogger();
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No consultation open. Call open() first.');

    logger?.debug('Loading summaries from backend', {
      operation: 'loadSummaries',
      component: 'useArcaSession',
      sdk: { consultationId: consultation.id },
    });

    const summaries = await apiClient.get<SummaryResponse[]>(SUMMARY_ENDPOINTS.LIST(consultation.id));
    store.setSummaries(summaries);

    return summaries;
  }, [store, getLogger]);

  const consultation = useMemo<Consultation | null>(() => {
    if (!store.consultation) return null;
    return {
      id: store.consultation.id,
      patientId: store.consultation.patientId,
      doctorId: store.consultation.doctorId,
      doctorName: store.consultation.doctorName,
      appointmentDate: store.consultation.appointmentDate,
      department: store.consultation.department,
      status: store.consultation.status,
      metadata: store.consultation.metadata,
      createdAt: store.consultation.createdAt,
      updatedAt: store.consultation.updatedAt,
    };
  }, [store.consultation]);

  return useMemo(
    () => ({
      // State
      consultation,
      context: store.contextItems,
      isLoading: store.sessionLoading,
      error: store.sessionError,
      // Actions
      open,
      addContext,
      getSharedContext,
      getPatientHistory,
      loadConsultation,
      loadSummaries,
      update,
      prime,
      close,
      reopen,
    }),
    [
      consultation,
      store.contextItems,
      store.sessionLoading,
      store.sessionError,
      open,
      addContext,
      getSharedContext,
      getPatientHistory,
      loadConsultation,
      loadSummaries,
      update,
      prime,
      close,
      reopen,
    ],
  );
}
