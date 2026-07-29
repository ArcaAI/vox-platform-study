import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { JobQueue, KnowledgeChunkFactory, KnowledgeChunkRepository, KnowledgeDocumentRepository } from '@arcaai/domains';
import { KnowledgeIngestClient } from './knowledge-ingest.client';
import { assertEqualTenants, createWorkerSession, encryptPhiFields } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';

/**
 * Payload for the IngestKnowledgeDocument job. `text` travels in the payload
 * (not a persisted column) — apps/api stays the sole DB reader and supplies the
 * raw content for the harness chunk+embed pass at enqueue time.
 */
export interface IngestKnowledgeDocumentJobPayload {
  jobId?: string;
  knowledgeDocumentId: string;
  tenantId: string;
  userId?: string;
  text: string;
}

export interface IngestKnowledgeDocumentResult {
  knowledgeDocumentId: string;
  chunkCount: number;
  chunkIds: string[];
}

/**
 * IngestKnowledgeDocumentProcessor — institutional RAG.
 *
 * Mirrors SummaryProcessor: a fail-closed `tenantId` guard, a CLS rebind via
 * `createWorkerSession` (worker processes run outside the API edge ClsModule
 * middleware, so the tenantScope Prisma extension needs the context re-bound),
 * an `assertEqualTenants` defense-in-depth check against a stale payload, and
 * progress events.
 *
 * It calls the harness internal ingest endpoint (chunk + embed + Qdrant upsert),
 * persists one KnowledgeChunk row per returned chunk, then marks the document
 * ingested (`ingestedAt` + `chunkCount`). A harness 503 propagates so BullMQ
 * retries the job.
 */
@Processor(JobQueue.IngestKnowledgeDocument)
export class IngestKnowledgeDocumentProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestKnowledgeDocumentProcessor.name);

  constructor(
    private readonly knowledgeDocumentRepository: KnowledgeDocumentRepository,
    private readonly knowledgeChunkRepository: KnowledgeChunkRepository,
    private readonly ingestClient: KnowledgeIngestClient,
    private readonly cls: ClsService<IActiveUserContext>,
    // Optional + trailing so existing positional fixtures
    // keep their arity; when wired, each chunk's `text` is encrypted into the
    // `encryptedText` column before persist (dual-write soak).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super();
  }

  /**
   * Encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  async process(job: Job<IngestKnowledgeDocumentJobPayload>): Promise<IngestKnowledgeDocumentResult> {
    const { jobId, knowledgeDocumentId, tenantId, userId, text } = job.data;
    // Fail-closed when tenantId is missing (guards legacy / poisoned queue entries).
    if (!tenantId) {
      throw new Error(`Job ${jobId ?? job.id} is missing required tenantId`);
    }

    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId, tenantId, kind: 'ingest-knowledge' }));

      await job.updateProgress(10);

      const document = await this.knowledgeDocumentRepository.findById(knowledgeDocumentId);
      if (!document) {
        throw new Error(`KnowledgeDocument ${knowledgeDocumentId} not found`);
      }
      // Defense in depth against a stale payload whose tenant no longer matches.
      assertEqualTenants(document, { tenantId });

      await job.updateProgress(30);

      // Harness owns chunking/embedding/Qdrant. A 503 here throws → job retries.
      const response = await this.ingestClient.ingest({
        tenantId,
        knowledgeDocumentId,
        title: document.title,
        source: document.source,
        mimeType: document.mimeType,
        text,
      });

      await job.updateProgress(70);

      const chunkIds: string[] = [];
      for (const chunk of response.chunks ?? []) {
        const entity = KnowledgeChunkFactory.CreateKnowledgeChunk({
          tenantId,
          knowledgeDocumentId,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          tokenCount: chunk.tokenCount,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          qdrantPointId: chunk.qdrantPointId,
          embeddingModel: chunk.embeddingModel,
          embeddingDim: chunk.embeddingDim,
          status: chunk.status,
          createdBy: userId ?? null,
        });
        await this.encryptBestEffort('KnowledgeChunk', () => this.knowledgeChunkRepository.encryptFieldsIntoEntity(entity, this.secretsService!));
        const saved = await this.knowledgeChunkRepository.create(entity);
        chunkIds.push(saved?.id ?? entity.id);
      }

      // Mark the document ingested (ingestedAt + chunkCount) and persist.
      document.markIngested(response.chunkCount);
      document.updatedBy = userId ?? null;
      await this.knowledgeDocumentRepository.update(document.id, document);

      await job.updateProgress(100);

      this.logger.log({
        message: 'Knowledge document ingestion completed',
        jobId,
        knowledgeDocumentId,
        chunkCount: response.chunkCount,
      });

      return { knowledgeDocumentId, chunkCount: response.chunkCount, chunkIds };
    });
  }
}
