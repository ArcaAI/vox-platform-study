/**
 * @arcaai/vox - Session Utilities (REFACTOR-02)
 *
 * Shared session operations used by both useArca and useArcaSession.
 * Extracts duplicated logic into testable, hook-agnostic functions.
 */

import type { Consultation, OpenSessionInput, ContextItem, PaginationParams } from '../types';
import { CONSULTATION_ENDPOINTS } from './constants';
import type { AgenticClient } from './AgenticClient';
import type { ISDKLogger } from './logger';

interface SessionStore {
  setSessionLoading: (loading: boolean) => void;
  setSessionError: (error: Error | null) => void;
  setConsultation: (consultation: Consultation) => void;
  clearContext: () => void;
  addContextItem: (item: ContextItem) => void;
}

export async function openSessionOperation(
  apiClient: AgenticClient,
  store: SessionStore,
  logger: ISDKLogger | undefined,
  input: OpenSessionInput,
): Promise<Consultation> {
  const timer = logger?.startOperation('openSession', {
    component: 'sessionUtils',
    attributes: { patientId: input.patientId, appointmentDate: input.appointmentDate },
  });

  store.setSessionLoading(true);
  store.setSessionError(null);

  try {
    const consultation = await apiClient.post<Consultation>(
      CONSULTATION_ENDPOINTS.OPEN,
      input,
    );

    store.setConsultation(consultation);
    store.clearContext();

    if (consultation.contextItems) {
      consultation.contextItems.forEach((item: ContextItem) => {
        store.addContextItem(item);
      });
    }

    timer?.end(true, {
      sdk: { consultationId: consultation.id },
      attributes: { isNew: consultation.isNew, patientId: input.patientId },
    });

    return consultation;
  } catch (error) {
    timer?.error(error as Error);
    store.setSessionError(error as Error);
    throw error;
  } finally {
    store.setSessionLoading(false);
  }
}

export async function loadConsultationOperation(
  apiClient: AgenticClient,
  store: SessionStore,
  logger: ISDKLogger | undefined,
  consultationId: string,
): Promise<Consultation> {
  const timer = logger?.startOperation('loadConsultation', {
    component: 'sessionUtils',
    sdk: { consultationId },
  });

  store.setSessionLoading(true);
  store.setSessionError(null);

  try {
    const consultation = await apiClient.get<Consultation>(
      CONSULTATION_ENDPOINTS.GET(consultationId),
    );

    store.setConsultation(consultation);
    store.clearContext();

    if (consultation.contextItems) {
      consultation.contextItems.forEach((item: ContextItem) => {
        store.addContextItem(item);
      });
    }

    timer?.end(true, { sdk: { consultationId: consultation.id } });
    return consultation;
  } catch (error) {
    timer?.error(error as Error);
    store.setSessionError(error as Error);
    throw error;
  } finally {
    store.setSessionLoading(false);
  }
}

export async function getPatientHistoryOperation(
  apiClient: AgenticClient,
  logger: ISDKLogger | undefined,
  patientId: string,
  pagination?: PaginationParams,
): Promise<Consultation[]> {
  logger?.debug('Getting patient history', {
    operation: 'getPatientHistory',
    component: 'sessionUtils',
    attributes: { patientId },
  });

  let url = CONSULTATION_ENDPOINTS.PATIENT_HISTORY(patientId);
  if (pagination) {
    const params = new URLSearchParams();
    if (pagination.page != null) params.set('page', String(pagination.page));
    if (pagination.limit != null) params.set('limit', String(pagination.limit));
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  return apiClient.get<Consultation[]>(url);
}
