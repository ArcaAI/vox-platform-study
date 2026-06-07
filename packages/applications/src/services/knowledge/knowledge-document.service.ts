import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { uuidv7 } from 'uuidv7';
import {
  JobQueue,
  KnowledgeDocumentEntity,
  KnowledgeDocumentFactory,
  KnowledgeDocumentRepository,
} from '@arcaai/domains';
import { InternalServerErrorException } from '@arcaai/exceptions';
import { assertEqualTenants } from '../../common';
import type { IngestKnowledgeDocumentJobPayload } from './ingest-knowledge-document.processor';

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
 * KnowledgeDocumentService (TASK-330 Phase 3 — institutional RAG).
 *
 * Admin-side CRUD + approval workflow for the institutional knowledge corpus
 * (mirrors EvalService: `tenantId` supplied explicitly by the API caller, built
 * via the domain factory, persisted through the repository). Approving a DRAFT
 * document gates it for retrieval and enqueues the BullMQ IngestKnowledgeDocument
 * job, which calls the harness to chunk+embed+upsert into Qdrant.
 */
@Injectable()
export class KnowledgeDocumentService {
  constructor(
    private readonly knowledgeDocumentRepository: KnowledgeDocumentRepository,
    @InjectQueue(JobQueue.IngestKnowledgeDocument) private readonly ingestQueue: Queue,
  ) {}

  /** Register a new source document (status = DRAFT). */
  async registerDocument(input: RegisterKnowledgeDocumentInput): Promise<KnowledgeDocumentEntity> {
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
    return created;
  }

  /** Load a single document (throws NotFound — no cross-tenant existence leak). */
  async getDocument(id: string): Promise<KnowledgeDocumentEntity> {
    const document = await this.knowledgeDocumentRepository.findById(id);
    if (!document) {
      throw new NotFoundException(`KnowledgeDocument ${id} not found`);
    }
    return document;
  }

  /** List the tenant's documents (repository auto-scopes by CLS tenant). */
  async listDocuments(): Promise<KnowledgeDocumentEntity[]> {
    return this.knowledgeDocumentRepository.findAll({});
  }

  /**
   * Approve a DRAFT document (DRAFT -> APPROVED) and enqueue ingestion. The raw
   * `text` travels in the job payload (apps/api stays the sole DB reader; only
   * the document's checksum is persisted, not its full content).
   */
  async approveDocument(id: string, input: ApproveKnowledgeDocumentInput): Promise<KnowledgeDocumentEntity> {
    const document = await this.knowledgeDocumentRepository.findById(id);
    if (!document) {
      throw new NotFoundException(`KnowledgeDocument ${id} not found`);
    }
    // Defense in depth — no cross-tenant approval / existence leak.
    assertEqualTenants(document, { tenantId: input.tenantId });

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

    return updated;
  }
}
