import type { PaginatedQuery } from '../../common';
import type { KnowledgeDocumentResponse, PaginatedKnowledgeChunkResponse, PaginatedKnowledgeDocumentResponse } from './dto';

export interface RegisterKnowledgeDocumentInput {
  tenantId: string;
  title: string;
  source: string;
  sourceType: string;
  mimeType: string;
  checksum: string;
  createdBy?: string | null;
}

export interface ApproveKnowledgeDocumentInput {
  tenantId: string;
  /** Raw document content — forwarded to the harness for chunk+embed (not persisted). */
  text: string;
  approvedBy?: string | null;
  /** Optional explicit BullMQ jobId (also the SSE channel key); generated when absent. */
  jobId?: string;
}

/**
 * Institutional-RAG knowledge corpus — admin CRUD/approval + tenant-admin
 * governance (archive/delete) over `KnowledgeDocument` and its `KnowledgeChunk`
 * children.
 *
 * ## Two rules that are easy to get wrong
 *
 * 1. **Every by-id path answers 404, never 403** on a cross-tenant id
 *    (404-over-403 — `findOwnedOrThrow` runs first on every one).
 * 2. **`deleteDocument` is fail-closed on the Qdrant cleanup call.** It calls
 *    the harness's vector-delete endpoint BEFORE the Postgres soft-delete
 *    commits; if that call fails, the whole delete is aborted (the document
 *    stays listed) rather than leaving a "deleted" row whose content is still
 *    retrievable by the RAG pipeline. See the service's docstring for the
 *    verified Qdrant-ordering evidence this decision rests on.
 *
 * `registerDocument`/`approveDocument` currently have no REST caller (the
 * admin controller does not expose create/approve routes — document
 * registration stays on the existing worker-triggering ingest flow); they are
 * kept as the programmatic entry points a future admin-console create flow
 * would use.
 */
export const IKnowledgeDocumentService = Symbol('IKnowledgeDocumentService');

export interface IKnowledgeDocumentService {
  /** Register a new source document (status = DRAFT). */
  registerDocument(input: RegisterKnowledgeDocumentInput): Promise<KnowledgeDocumentResponse>;

  /**
   * Approve a DRAFT document (DRAFT -> APPROVED) and enqueue harness
   * chunk+embed+upsert ingestion.
   */
  approveDocument(id: string, input: ApproveKnowledgeDocumentInput): Promise<KnowledgeDocumentResponse>;

  /** One document. 404 when missing OR cross-tenant. A forced-audited read (content-adjacent). */
  getDocument(id: string): Promise<KnowledgeDocumentResponse>;

  /** Paginated list of the caller tenant's documents. */
  listDocuments(query: PaginatedQuery): Promise<PaginatedKnowledgeDocumentResponse>;

  /**
   * Paginated, decrypted chunk content for one document, ordered by
   * `chunkIndex`. A forced-audited read — chunk text is the sensitive payload
   * the assignment's "audit on every memory read" requirement targets.
   *
   * @throws NotFoundException — missing or cross-tenant document id
   */
  listChunks(documentId: string, query: PaginatedQuery): Promise<PaginatedKnowledgeChunkResponse>;

  /** Soft-touch: status -> ARCHIVED. NOT a delete — chunks/vectors are untouched. */
  archiveDocument(id: string): Promise<KnowledgeDocumentResponse>;

  /**
   * Soft-delete the document AND remove its vectors from Qdrant. Fail-closed:
   * a Qdrant cleanup failure aborts the whole operation (nothing is
   * soft-deleted) rather than leaving orphaned-but-retrievable vectors behind
   * a "deleted" Postgres row.
   *
   * @throws NotFoundException — missing or cross-tenant document id
   * @throws InternalServerErrorException — the harness vector-cleanup call failed
   */
  deleteDocument(id: string): Promise<KnowledgeDocumentResponse>;
}
