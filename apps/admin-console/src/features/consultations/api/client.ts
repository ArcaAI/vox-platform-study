/**
 * Admin consultation reads (capabilities-matrix row 33) — a READ-ONLY surface:
 * list + aggregate + :id detail, no mutations anywhere. Scope follows the
 * caller: tenant-pinned normally; a SUPER_ADMIN with no working tenant reads
 * cross-tenant (the frame 40 aggregate exception).
 */

import { getJson } from '@/shared/api';
import type { Consultation, ConsultationAggregate, ConsultationAggregateParams, ListConsultationsParams, PaginatedConsultations } from './types';

const CONSULTATIONS = 'admin/consultations';

/** NOTE: `page` is 1-based on this endpoint (see ListConsultationsParams). */
export function listConsultations(params?: ListConsultationsParams): Promise<PaginatedConsultations> {
    return getJson(CONSULTATIONS, params);
}

/** Zero-filled new/revisit buckets; `from`/`to` are required (400 without). */
export function getConsultationAggregate(params: ConsultationAggregateParams): Promise<ConsultationAggregate> {
    return getJson(`${CONSULTATIONS}/aggregate`, params);
}

/** Read-only detail with relations (doctor, department, context items). */
export function getConsultation(id: string): Promise<Consultation> {
    return getJson(`${CONSULTATIONS}/${encodeURIComponent(id)}`);
}
