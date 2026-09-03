/**
 * Types for institutional-RAG knowledge-document administration
 * (`/admin/knowledge/documents`). Mirrors the response DTOs in
 * `packages/applications/src/services/knowledge/dto/` — kept hand-written
 * (not imported) because `apps/admin-console` does not depend on
 * `@arcaai/applications` (a server-side package).
 */

export type KnowledgeDocumentStatus = 'DRAFT' | 'APPROVED' | 'ARCHIVED';

export interface KnowledgeDocument {
  id: string;
  tenantId: string;
  title: string;
  /** Origin reference (filename / URL / path). */
  source: string;
  /** Loader/source category, e.g. "text", "markdown", "upload". */
  sourceType: string;
  mimeType: string;
  /** Content hash for dedup / change detection. */
  checksum: string;
  status: KnowledgeDocumentStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Set once the harness ingest job has completed. */
  ingestedAt: string | null;
  chunkCount: number;
  /** Optimistic-concurrency counter. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeChunk {
  id: string;
  tenantId: string;
  knowledgeDocumentId: string;
  chunkIndex: number;
  /**
   * Decrypted chunk text, server-side decrypt-on-read. Null when the
   * platform runs without Vault-mode secrets (local dev).
   */
  text: string | null;
  tokenCount: number;
  startOffset: number;
  endOffset: number;
  /** The point id in the harness-owned Qdrant `knowledge_chunks` collection. */
  qdrantPointId: string;
  embeddingModel: string;
  embeddingDim: number;
  status: string;
  createdAt: string;
}
