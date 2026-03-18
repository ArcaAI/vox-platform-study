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
} from '../types';
import { CONSULTATION_ENDPOINTS, CONTEXT_ENDPOINTS, SUMMARY_ENDPOINTS } from '../core/constants';
import { SimpleCrossTabSync, createCrossTabSync } from '../core/SimpleCrossTabSync';
import type { ISDKLogger } from '../core/logger';
import {
  openSessionOperation,
  loadConsultationOperation,
  getPatientHistoryOperation,
} from '../core/sessionUtils';

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
      crossTabSyncRef.current = createCrossTabSync({
        patientId: consultation.patientId,
        doctorId: consultation.doctorId,
        appointmentDate: consultation.appointmentDate,
      });
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
   * Add context to the current consultation
   */
  const addContext = useCallback(
    async (input: AddContextInput): Promise<ContextItem> => {
      const { apiClient, consultation } = store;
      const logger = getLogger();
      if (!apiClient) throw new Error('SDK not initialized');
      if (!consultation) throw new Error('No consultation open. Call open() first.');

      const timer = logger?.startOperation('addContext', {
        component: 'useArcaSession',
        sdk: { consultationId: consultation.id },
        attributes: { type: input.type },
      });

      try {
        const contextItem = await apiClient.post<ContextItem>(
          CONTEXT_ENDPOINTS.ADD(consultation.id),
          input
        );

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
    [store, getLogger]
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

    const sharedContext = await apiClient.get<ContextItem[]>(
      CONTEXT_ENDPOINTS.SHARED(consultation.id)
    );

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
   * Close the current consultation (transition status to CLOSED).
   */
  const close = useCallback(async (): Promise<Consultation> => {
    const { apiClient, consultation } = store;
    const logger = getLogger();
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No consultation open. Call open() first.');

    const timer = logger?.startOperation('close', {
      component: 'useArcaSession',
      sdk: { consultationId: consultation.id },
    });

    try {
      const updated = await apiClient.post<Consultation>(
        CONSULTATION_ENDPOINTS.CLOSE(consultation.id),
        {}
      );
      store.setConsultation(updated);
      timer?.end(true);
      return updated;
    } catch (error) {
      timer?.error(error as Error);
      throw error;
    }
  }, [store, getLogger]);

  /**
   * Reopen a previously closed consultation (transition status to OPEN).
   */
  const reopen = useCallback(async (): Promise<Consultation> => {
    const { apiClient, consultation } = store;
    const logger = getLogger();
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No consultation open. Call open() first.');

    const timer = logger?.startOperation('reopen', {
      component: 'useArcaSession',
      sdk: { consultationId: consultation.id },
    });

    try {
      const updated = await apiClient.post<Consultation>(
        CONSULTATION_ENDPOINTS.REOPEN(consultation.id),
        {}
      );
      store.setConsultation(updated);
      timer?.end(true);
      return updated;
    } catch (error) {
      timer?.error(error as Error);
      throw error;
    }
  }, [store, getLogger]);

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

    const summaries = await apiClient.get<SummaryResponse[]>(
      SUMMARY_ENDPOINTS.LIST(consultation.id)
    );
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
      close,
      reopen,
    ]
  );
}
