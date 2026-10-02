/**
 * Admin consultation reads (capabilities-matrix row 33) — a READ-ONLY surface:
 * list + aggregate + :id detail, no mutations anywhere. Scope follows the
 * caller: tenant-pinned normally; a SUPER_ADMIN with no working tenant reads
 * cross-tenant (the frame 40 aggregate exception).
 */

import { getJson, postJson } from '@/shared/api';
import type {
  ComposedPromptRecord,
  ComposedPromptRecordSummary,
  Consultation,
  ConsultationAggregate,
  ConsultationAggregateParams,
  ListConsultationsParams,
  PaginatedConsultations,
  PromptPreviewRequest,
  PromptPreviewResponse,
} from './types';

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

/** Dry-run composition of one phase's LLM request for this consultation (audited server-side). */
export function previewConsultationPrompt(id: string, body: PromptPreviewRequest): Promise<PromptPreviewResponse> {
  return postJson(`${CONSULTATIONS}/${encodeURIComponent(id)}/prompt-preview`, body);
}

/** Stored composed-prompt records for a consultation — metadata only. Accepts a bare array or a `{ data }` page. */
export async function listComposedPrompts(consultationId: string): Promise<ComposedPromptRecordSummary[]> {
  const body = await getJson<ComposedPromptRecordSummary[] | { data?: ComposedPromptRecordSummary[] }>('admin/composed-prompts', { consultationId });
  return Array.isArray(body) ? body : (body?.data ?? []);
}

/** One stored record, decrypted (audited server-side). */
export function getComposedPrompt(id: string): Promise<ComposedPromptRecord> {
  return getJson(`admin/composed-prompts/${encodeURIComponent(id)}`);
}
