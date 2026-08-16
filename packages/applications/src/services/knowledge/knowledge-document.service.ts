import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Queue } from 'bullmq';
import { uuidv7 } from 'uuidv7';
import {
  JobQueue,
  KnowledgeChunkRepository,
  KnowledgeDocumentEntity,
  KnowledgeDocumentFactory,
  KnowledgeDocumentRepository,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { InternalServerErrorException } from '@arcaai/exceptions';
import { BaseService, PaginatedQuery, assertEqualTenants, withFormattedCountProps, withFormattedPaginatedProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { ApproveKnowledgeDocumentInput, IKnowledgeDocumentService, RegisterKnowledgeDocumentInput } from './IKnowledgeDocumentService';
import { KnowledgeDocumentResponse, PaginatedKnowledgeChunkResponse, PaginatedKnowledgeDocumentResponse } from './dto';
import { KnowledgeDocumentDtoMapper } from './knowledge-document.dto.mapper';
import { KnowledgeVectorCleanupClient } from './knowledge-vector-cleanup.client';
import type { IngestKnowledgeDocumentJobPayload } from './ingest-knowledge-document.processor';

/**
 * KnowledgeDocumentService — institutional RAG.
 *
 * Admin-side CRUD + governance for the institutional knowledge corpus:
 * register/approve (worker-triggering ingest, unchanged in shape), plus
 * TASK-728's tenant-admin governance surface — inspect (`getDocument`,
 * `listChunks`), and manual archive/delete now that nothing auto-expires
 * this content (see `docs/implementation/TASK-728-Memory-Management-Screens`).
 *
 * ## `deleteDocument` is FAIL-CLOSED on the Qdrant vector cleanup
 *
 * `deleteDocument` calls `KnowledgeVectorCleanupClient.deleteByDocument`
 * (the harness `DELETE /internal/knowledge/{id}` endpoint) BEFORE the
 * Postgres soft-delete, and aborts the whole operation if that call throws.
 * The alternative — soft-delete Postgres regardless and queue a best-effort
 * async Qdrant retry — is also defensible, but leaving PHI-adjacent content
 * retrievable behind a "deleted" label is the worse failure mode on a
 * healthcare platform, so this ticket picks fail-closed. This is verified
 * SAFE to do synchronously: a live local Qdrant instance was probed directly
 * (TASK-728 research) and `client.delete()`'s default `wait=True` makes the
 * delete-by-filter call block until the removal is actually applied —
 * `points_count` reflected the removal before the call returned, and a
 * compound `(tenant_id, knowledge_document_id)` filter left a same-document
 * point belonging to a DIFFERENT tenant untouched. A caller that gets a
 * normal return from the harness endpoint can therefore trust the vectors
 * are gone, not merely queued for removal — there is no propagation-lag
 * window that would make fail-closed feel slower than it looks.
 */
@Injectable()
export class KnowledgeDocumentService extends BaseService implements IKnowledgeDocumentService {
  constructor(
    private readonly knowledgeDocumentRepository: KnowledgeDocumentRepository,
    private readonly knowledgeChunkRepository: KnowledgeChunkRepository,
    @InjectQueue(JobQueue.IngestKnowledgeDocument) private readonly ingestQueue: Queue,
    private readonly vectorCleanupClient: KnowledgeVectorCleanupClient,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.KnowledgeDocument);
  }

  // ============================================================
  // Register / approve (worker-triggering ingest — unchanged shape)
  // ============================================================

  async registerDocument(input: RegisterKnowledgeDocumentInput): Promise<KnowledgeDocumentResponse> {
    const entity = KnowledgeDocumentFactory.CreateKnowledgeDocument({
      tenantId: input.tenantId,
      title: input.title,
      source: input.source,
      sourceType: input.sourceType,
      mimeType: input.mimeType,
      checksum: input.checksum,
      createdBy: input.createdBy ?? null,
    });

    const created = await this.knowledgeDocumentRepository.create(entity);
    if (!created) {
      throw new InternalServerErrorException('Failed to create KnowledgeDocumentEntity');
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: created.id,
      createdAt: created.createdAt,
      data: { title: created.title, source: created.source },
    });

    return KnowledgeDocumentDtoMapper.toResponse(created);
  }

  async approveDocument(id: string, input: ApproveKnowledgeDocumentInput): Promise<KnowledgeDocumentResponse> {
    const document = await this.knowledgeDocumentRepository.findById(id).catch(() => null);
    if (!document) {
      throw new NotFoundException(`KnowledgeDocument ${id} not found`);
    }
    // Defense in depth — no cross-tenant approval / existence leak.
    assertEqualTenants(document, { tenantId: input.tenantId });

    const previousVersion = document.version;
    document.approve(input.approvedBy);
    document.updatedBy = input.approvedBy ?? null;

    const updated = await this.knowledgeDocumentRepository.update(id, document);
    if (!updated) {
      throw new InternalServerErrorException('Failed to update KnowledgeDocumentEntity');
    }

    const jobId = input.jobId ?? uuidv7();
    const payload: IngestKnowledgeDocumentJobPayload = {
      jobId,
      knowledgeDocumentId: id,
      tenantId: input.tenantId,
      userId: input.approvedBy ?? undefined,
      text: input.text,
    };
    await this.ingestQueue.add(JobQueue.IngestKnowledgeDocument, payload, {
      jobId,
      attempts: 3,
    });

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { action: 'approve', previousVersion, newVersion: updated.version },
    });

    return KnowledgeDocumentDtoMapper.toResponse(updated);
  }

  // ============================================================
  // Inspect (audited reads)
  // ============================================================

  /** One document. 404 when missing OR cross-tenant. A forced-audited read. */
  async getDocument(id: string): Promise<KnowledgeDocumentResponse> {
    const tenantId = this.requireTenantId();
    const document = await this.findOwnedOrThrow(id, tenantId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: document.id,
      data: { action: 'getDocument' },
      forceAuditLog: true,
    });

    return KnowledgeDocumentDtoMapper.toResponse(document);
  }

  /** Paginated list of the caller tenant's documents. Not forced — no content read, just metadata. */
  async listDocuments(query: PaginatedQuery): Promise<PaginatedKnowledgeDocumentResponse> {
    const paginated = withFormattedPaginatedProps(query, 'KnowledgeDocument');
    const [data, count] = await Promise.all([
      this.knowledgeDocumentRepository.findAll(paginated),
      this.knowledgeDocumentRepository.count(withFormattedCountProps(query, 'KnowledgeDocument')),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { action: 'listDocuments', count: data.length },
    });

    return KnowledgeDocumentDtoMapper.toPaginatedResponse({ data, count, limit: paginated.limit, page: paginated.page });
  }

  /**
   * Paginated, decrypted chunk content for one document, ordered by
   * `chunkIndex`. A forced-audited read — chunk TEXT is the sensitive payload
   * the "audit on every memory read" requirement targets (unlike the
   * metadata-only `listDocuments`). `entity.text` is auto-decrypted on read
   * by the base repository's PHI decrypt-on-read wrapper when Vault-mode
   * secrets are wired; it is `null` in local dev.
   */
  async listChunks(documentId: string, query: PaginatedQuery): Promise<PaginatedKnowledgeChunkResponse> {
    const tenantId = this.requireTenantId();
    const document = await this.findOwnedOrThrow(documentId, tenantId);

    const paginated = withFormattedPaginatedProps(query);
    const [data, count] = await Promise.all([
      this.knowledgeChunkRepository.findAll({
        ...paginated,
        where: { knowledgeDocumentId: document.id },
        sort: paginated.sort ?? [{ chunkIndex: 'asc' }],
      }),
      this.knowledgeChunkRepository.count({
        ...withFormattedCountProps(query),
        where: { knowledgeDocumentId: document.id },
      }),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: document.id,
      data: { action: 'listChunks', count: data.length },
      forceAuditLog: true,
    });

    return KnowledgeDocumentDtoMapper.toPaginatedChunkResponse({ data, count, limit: paginated.limit, page: paginated.page });
  }

  // ============================================================
  // Governance — manual archive / delete (no automatic TTL exists yet)
  // ============================================================

  /** Soft-touch: status -> ARCHIVED. NOT a delete — chunks/vectors are untouched. */
  async archiveDocument(id: string): Promise<KnowledgeDocumentResponse> {
    const tenantId = this.requireTenantId();
    const document = await this.findOwnedOrThrow(id, tenantId);

    document.archiveContent();
    document.updatedBy = this.requestUserId ?? undefined;

    const updated = await this.knowledgeDocumentRepository.update(id, document);
    if (!updated) {
      throw new InternalServerErrorException('Failed to update KnowledgeDocumentEntity');
    }

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { action: 'archive' },
    });

    return KnowledgeDocumentDtoMapper.toResponse(updated);
  }

  /**
   * Soft-delete the document AND remove its vectors from Qdrant. See the
   * class docstring for why this is fail-closed on the Qdrant call.
   */
  async deleteDocument(id: string): Promise<KnowledgeDocumentResponse> {
    const tenantId = this.requireTenantId();
    const document = await this.findOwnedOrThrow(id, tenantId);

    try {
      await this.vectorCleanupClient.deleteByDocument({ tenantId, knowledgeDocumentId: document.id });
    } catch (error) {
      // Fail-closed: nothing is soft-deleted when the harness cannot confirm
      // the vectors are gone. An orphaned-but-still-listed document is safer
      // than a Postgres row that says "deleted" while its content remains
      // retrievable by the RAG pipeline.
      throw new InternalServerErrorException(
        `Failed to remove Qdrant vectors for KnowledgeDocument ${id}; delete aborted: ${(error as Error).message}`,
      );
    }

    const deleted = await this.knowledgeDocumentRepository.softDelete(id, this.requestUserId ?? undefined);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: { title: deleted.title },
    });

    return KnowledgeDocumentDtoMapper.toResponse(deleted);
  }

  // ============================================================
  // Internals
  // ============================================================

  /** Matches `ConsultationContextSchemaService.requireTenantId` — the closest structural exemplar. */
  private requireTenantId(): string {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    return tenantId;
  }

  /**
   * Load by id and enforce tenant ownership. Mismatch (or missing) throws
   * `NotFoundException` — never `ForbiddenException` — so a cross-tenant
   * caller cannot infer the row exists (04-application-services.md).
   */
  private async findOwnedOrThrow(id: string, tenantId: string): Promise<KnowledgeDocumentEntity> {
    const entity = await this.knowledgeDocumentRepository.findById(id).catch(() => null);
    if (!entity || entity.tenantId !== tenantId) {
      throw new NotFoundException(`KnowledgeDocument ${id} not found`);
    }
    return entity;
  }
}
