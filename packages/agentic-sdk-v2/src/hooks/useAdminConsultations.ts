/**
 * @arcaai/vox - useAdminConsultations Hook
 *
 * Tenant-wide consultation supervision for TENANT_ADMIN / SUPER_ADMIN. The
 * server gates `/admin/consultations` with `@CanManage('Consultation')`, so a
 * plain DOCTOR is denied (403) — the rejection surfaces here as a clean
 * `AgenticError('FORBIDDEN')`.
 *
 * Distinct from `useArca().session.listConsultations` (the owner-/shared-scoped
 * end-user surface): this reads EVERY consultation in the caller's tenant.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { ADMIN_CONSULTATION_ENDPOINTS } from '../core/constants';
import { extractPaginated } from '../utils/responseUtils';
import { appendPagination, appendFilters } from '../utils/urlUtils';
import type { PaginationParams, PaginatedResponse } from '../types/common';

/**
 * Tenant-wide consultation record. Minimal local shape (mirrors the SDK's
 * other admin hooks) with an index signature so server fields the SDK does
 * not yet model pass through untouched.
 */
export interface AdminConsultation {
  id: string;
  patientId?: string;
  doctorId?: string;
  departmentId?: string;
  status?: string;
  appointmentDate?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/**
 * Filters accepted by {@link UseAdminConsultationsReturn.list}. Pagination uses
 * the SDK's `page`/`limit` convention (the wire param the controller reads is
 * `limit`; it maps that to its internal `pageSize`).
 */
export interface AdminConsultationListParams extends PaginationParams {
  patientId?: string;
  doctorId?: string;
  departmentId?: string;
}

export interface UseAdminConsultationsReturn {
  consultations: AdminConsultation[];
  currentConsultation: AdminConsultation | null;
  isLoading: boolean;
  error: Error | null;
  list: (params?: AdminConsultationListParams) => Promise<PaginatedResponse<AdminConsultation>>;
  get: (id: string) => Promise<AdminConsultation>;
}

export function useAdminConsultations(): UseAdminConsultationsReturn {
  const { execute, isLoading, error } = useApiOperation('useAdminConsultations');

  const [consultations, setConsultations] = useState<AdminConsultation[]>([]);
  const [currentConsultation, setCurrentConsultation] = useState<AdminConsultation | null>(null);

  const list = useCallback(
    (params?: AdminConsultationListParams) =>
      execute<PaginatedResponse<AdminConsultation>>('list', async (client) => {
        let url: string = ADMIN_CONSULTATION_ENDPOINTS.LIST;
        if (params) {
          url = appendFilters(url, {
            patientId: params.patientId,
            doctorId: params.doctorId,
            departmentId: params.departmentId,
          });
          url = appendPagination(url, params.page !== undefined || params.limit !== undefined ? params : undefined);
        }
        const raw = await client.get(url);
        const result = extractPaginated<AdminConsultation>(raw);
        setConsultations(result.data);
        return result;
      }),
    [execute],
  );

  const get = useCallback(
    (id: string) =>
      execute<AdminConsultation>('get', async (client) => {
        const data = await client.get<AdminConsultation>(ADMIN_CONSULTATION_ENDPOINTS.GET(id));
        setCurrentConsultation(data);
        return data;
      }),
    [execute],
  );

  return { consultations, currentConsultation, isLoading, error, list, get };
}
