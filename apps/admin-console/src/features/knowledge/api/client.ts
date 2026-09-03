/**
 * Institutional-RAG knowledge-document admin CRUD-lite + governance
 * All paths are gateway-relative under the /api/hope BFF proxy,
 * mirroring `apps/api/src/modules/knowledge/knowledge.controller.ts`.
 *
 * No create/approve calls here: document registration/approval stays on the
 * existing worker-triggering ingest flow, which this feature does not surface
 * (see the controller's own doc comment) — this module is read + archive +
 * delete only.
 */

import { deleteJson, getJson, postJson } from '@/shared/api';
import type { Paginated } from '@/shared/api';
import type { KnowledgeChunk, KnowledgeDocument } from './types';

const BASE = 'admin/knowledge/documents';

const documentPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export interface ListKnowledgeDocumentsParams {
  page?: number;
  limit?: number;
  [key: string]: string | number | boolean | undefined;
}

export function listKnowledgeDocuments(params?: ListKnowledgeDocumentsParams): Promise<Paginated<KnowledgeDocument>> {
  return getJson(BASE, params);
}

export function getKnowledgeDocument(id: string): Promise<KnowledgeDocument> {
  return getJson(documentPath(id));
}

export interface ListKnowledgeChunksParams {
  page?: number;
  limit?: number;
  [key: string]: string | number | boolean | undefined;
}

/** Force-audited on the server — every call writes an AuditLog row (chunk text is the sensitive read). */
export function listKnowledgeChunks(id: string, params?: ListKnowledgeChunksParams): Promise<Paginated<KnowledgeChunk>> {
  return getJson(`${documentPath(id)}/chunks`, params);
}

/** Soft-touch: status -> ARCHIVED. NOT a delete — chunks/vectors are untouched. */
export function archiveKnowledgeDocument(id: string): Promise<KnowledgeDocument> {
  return postJson(`${documentPath(id)}/archive`);
}

/**
 * Soft-deletes the document AND removes its vectors from Qdrant, fail-closed
 * server-side: a 500 here means NOTHING was deleted (the harness could not
 * confirm the vectors were removed), not a partial delete.
 */
export function deleteKnowledgeDocument(id: string): Promise<KnowledgeDocument> {
  return deleteJson(documentPath(id));
}
