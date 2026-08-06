/**
 * IngestKnowledgeDocumentProcessor unit tests — institutional RAG.
 *
 * The processor mirrors SummaryProcessor: a fail-closed `tenantId` guard, a CLS
 * rebind via `createWorkerSession`, an `assertEqualTenants` defense-in-depth
 * check, and progress events. It calls the harness internal ingest endpoint
 * (MOCKED here — no real harness), then persists one KnowledgeChunk row per
 * returned chunk and marks the document ingested.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { KnowledgeDocumentStatus } from '@arcaai/domains';
import { IngestKnowledgeDocumentProcessor } from '../ingest-knowledge-document.processor';

const TENANT_A = 'tenant-A';

function buildDoc(overrides: Record<string, unknown> = {}) {
  // A minimal stand-in for a KnowledgeDocumentEntity: the markIngested()
  // lifecycle method + the fields the processor reads from the row.
  return {
    id: 'doc-1',
    tenantId: TENANT_A,
    title: 'Sepsis Protocol',
    source: 'protocols/sepsis.md',
    mimeType: 'text/markdown',
    status: KnowledgeDocumentStatus.APPROVED,
    chunkCount: 0,
    ingestedAt: null as Date | null,
    updatedBy: null as string | null,
    markIngested(count: number) {
      this.chunkCount = count;
      this.ingestedAt = new Date();
    },
    ...overrides,
  };
}

function ingestResponse() {
  return {
    chunkCount: 2,
    chunks: [
      {
        chunkIndex: 0,
        text: 'Give antibiotics within 1 hour.',
        qdrantPointId: 'pt-0',
        startOffset: 0,
        endOffset: 31,
        tokenCount: 6,
        embeddingModel: 'BAAI/bge-m3',
        embeddingDim: 1024,
        status: 'APPROVED',
      },
      {
        chunkIndex: 1,
        text: 'Draw lactate and blood cultures.',
        qdrantPointId: 'pt-1',
        startOffset: 32,
        endOffset: 64,
        tokenCount: 5,
        embeddingModel: 'BAAI/bge-m3',
        embeddingDim: 1024,
        status: 'APPROVED',
      },
    ],
  };
}

function buildHarness(opts: { usageLedgerService?: unknown } = {}) {
  const knowledgeDocumentRepository = { findById: vi.fn(), update: vi.fn(async (_id, e) => e) };
  const knowledgeChunkRepository = { create: vi.fn(async (e) => e) };
  const ingestClient = { ingest: vi.fn() };
  // cls.run executes the callback synchronously (the worker rebind wrapper).
  const cls = { run: vi.fn(async (fn: () => unknown) => fn()), set: vi.fn() };
  const usageLedgerService = opts.usageLedgerService as { recordUsage: ReturnType<typeof vi.fn> } | undefined;

  const processor = new IngestKnowledgeDocumentProcessor(
    knowledgeDocumentRepository as never,
    knowledgeChunkRepository as never,
    ingestClient as never,
    cls as never,
    undefined, // secretsService
    usageLedgerService as never,
  );

  return { processor, knowledgeDocumentRepository, knowledgeChunkRepository, ingestClient, cls, usageLedgerService };
}

function buildJob(data: Record<string, unknown>) {
  return { id: 'job-1', data, timestamp: Date.now(), updateProgress: vi.fn() };
}

describe('IngestKnowledgeDocumentProcessor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fails closed when the job is missing tenantId', async () => {
    const { processor } = buildHarness();
    const job = buildJob({ knowledgeDocumentId: 'doc-1', text: 'x' });
    await expect(processor.process(job as never)).rejects.toThrow(/tenantId/i);
  });

  it('rebinds CLS, calls the harness, persists a chunk per result, and marks ingested', async () => {
    const { processor, knowledgeDocumentRepository, knowledgeChunkRepository, ingestClient, cls } = buildHarness();
    const doc = buildDoc();
    knowledgeDocumentRepository.findById.mockResolvedValue(doc);
    ingestClient.ingest.mockResolvedValue(ingestResponse());

    const job = buildJob({
      jobId: 'job-1',
      knowledgeDocumentId: 'doc-1',
      tenantId: TENANT_A,
      userId: 'admin-1',
      text: 'Give antibiotics within 1 hour. Draw lactate and blood cultures.',
    });

    const result = await processor.process(job as never);

    // CLS rebind happened with the tenant + a worker session
    expect(cls.run).toHaveBeenCalledTimes(1);
    expect(cls.set).toHaveBeenCalledWith('tenantId', TENANT_A);
    expect(cls.set).toHaveBeenCalledWith('user', expect.anything());

    // Harness called with the doc metadata + the payload text
    expect(ingestClient.ingest).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      knowledgeDocumentId: 'doc-1',
      title: 'Sepsis Protocol',
      source: 'protocols/sepsis.md',
      mimeType: 'text/markdown',
      text: 'Give antibiotics within 1 hour. Draw lactate and blood cultures.',
    });

    // One KnowledgeChunk persisted per returned chunk, with the mapped fields
    expect(knowledgeChunkRepository.create).toHaveBeenCalledTimes(2);
    const firstChunk = knowledgeChunkRepository.create.mock.calls[0][0];
    expect(firstChunk.knowledgeDocumentId).toBe('doc-1');
    expect(firstChunk.tenantId).toBe(TENANT_A);
    expect(firstChunk.chunkIndex).toBe(0);
    expect(firstChunk.qdrantPointId).toBe('pt-0');
    expect(firstChunk.embeddingDim).toBe(1024);
    expect(firstChunk.status).toBe('APPROVED');

    // Document marked ingested (ingestedAt + chunkCount) and persisted
    expect(doc.chunkCount).toBe(2);
    expect(doc.ingestedAt).toBeInstanceOf(Date);
    expect(knowledgeDocumentRepository.update).toHaveBeenCalledWith('doc-1', doc);

    expect(result.chunkCount).toBe(2);
  });

  it('rejects (no persistence) when the document belongs to another tenant', async () => {
    const { processor, knowledgeChunkRepository, ingestClient } = buildHarness();
    const { knowledgeDocumentRepository } = buildHarness();
    knowledgeDocumentRepository.findById.mockResolvedValue(buildDoc({ tenantId: 'tenant-B' }));

    // Rebuild the processor bound to the cross-tenant repo
    const procHarness = buildHarness();
    procHarness.knowledgeDocumentRepository.findById.mockResolvedValue(buildDoc({ tenantId: 'tenant-B' }));

    const job = buildJob({ knowledgeDocumentId: 'doc-1', tenantId: TENANT_A, text: 'x' });
    await expect(procHarness.processor.process(job as never)).rejects.toThrow(NotFoundException);
    expect(procHarness.ingestClient.ingest).not.toHaveBeenCalled();
    expect(procHarness.knowledgeChunkRepository.create).not.toHaveBeenCalled();
  });

  it('propagates a harness failure (503) so BullMQ retries, persisting nothing', async () => {
    const { processor, knowledgeDocumentRepository, knowledgeChunkRepository, ingestClient } = buildHarness();
    knowledgeDocumentRepository.findById.mockResolvedValue(buildDoc());
    ingestClient.ingest.mockRejectedValue(new Error('harness unavailable (503)'));

    const job = buildJob({ knowledgeDocumentId: 'doc-1', tenantId: TENANT_A, text: 'x' });
    await expect(processor.process(job as never)).rejects.toThrow(/503|unavailable/i);
    expect(knowledgeChunkRepository.create).not.toHaveBeenCalled();
    expect(knowledgeDocumentRepository.update).not.toHaveBeenCalled();
  });

  // TASK-615 WS-D2 (item 3) — the harness knowledge-ingest path embeds
  // through the self-hosted LM Studio OpenAI-compatible endpoint (see
  // apps/harness/src/harness/services/embeddings_client.py + core/config.py
  // `embeddings_base_url: http://localhost:1234/v1`), NOT a TEI reranker
  // instance — so the ledger provider slug is `lm-studio`, an id already in
  // KNOWN_PROVIDERS.
  describe('embedding usage emission (TASK-615 WS-D2)', () => {
    it('emits ONE embed INPUT_TOKEN row summing every chunk tokenCount for the ingest call', async () => {
      const usageLedgerService = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 1 }) };
      const { processor, knowledgeDocumentRepository, ingestClient } = buildHarness({ usageLedgerService });
      knowledgeDocumentRepository.findById.mockResolvedValue(buildDoc());
      ingestClient.ingest.mockResolvedValue(ingestResponse());

      const job = buildJob({
        jobId: 'job-embed-1',
        knowledgeDocumentId: 'doc-1',
        tenantId: TENANT_A,
        userId: 'admin-1',
        text: 'Give antibiotics within 1 hour. Draw lactate and blood cultures.',
      });

      await processor.process(job as never);

      expect(usageLedgerService.recordUsage).toHaveBeenCalledTimes(1);
      const [input] = usageLedgerService.recordUsage.mock.calls[0];
      expect(input.common).toMatchObject({
        tenantId: TENANT_A,
        idempotencyKey: 'embed:job-embed-1',
        capability: 'EMBEDDING',
        operation: 'embed',
        provider: 'lm-studio',
        model: 'BAAI/bge-m3',
        deployment: 'SELF_HOSTED',
        requestId: 'job-embed-1',
      });
      // ingestResponse() chunks carry tokenCount 6 + 5 = 11.
      expect(input.units).toEqual([{ unit: 'INPUT_TOKEN', quantity: 11 }]);
    });

    it('falls back to the BullMQ job id when the payload carries no jobId', async () => {
      const usageLedgerService = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 1 }) };
      const { processor, knowledgeDocumentRepository, ingestClient } = buildHarness({ usageLedgerService });
      knowledgeDocumentRepository.findById.mockResolvedValue(buildDoc());
      ingestClient.ingest.mockResolvedValue(ingestResponse());

      // buildJob() always sets id: 'job-1'; the payload omits jobId.
      const job = buildJob({ knowledgeDocumentId: 'doc-1', tenantId: TENANT_A, text: 'x' });
      await processor.process(job as never);

      const [input] = usageLedgerService.recordUsage.mock.calls[0];
      expect(input.common.idempotencyKey).toBe('embed:job-1');
    });

    it('emits nothing when no usage-ledger service is wired', async () => {
      const { processor, knowledgeDocumentRepository, ingestClient } = buildHarness();
      knowledgeDocumentRepository.findById.mockResolvedValue(buildDoc());
      ingestClient.ingest.mockResolvedValue(ingestResponse());

      const job = buildJob({ knowledgeDocumentId: 'doc-1', tenantId: TENANT_A, text: 'x' });
      await expect(processor.process(job as never)).resolves.toBeDefined();
    });

    it('emits nothing when the harness returned zero-token chunks (no work billed)', async () => {
      const usageLedgerService = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: [], events: 0 }) };
      const { processor, knowledgeDocumentRepository, ingestClient } = buildHarness({ usageLedgerService });
      knowledgeDocumentRepository.findById.mockResolvedValue(buildDoc());
      ingestClient.ingest.mockResolvedValue({ chunkCount: 0, chunks: [] });

      const job = buildJob({ knowledgeDocumentId: 'doc-1', tenantId: TENANT_A, text: 'x' });
      await processor.process(job as never);

      expect(usageLedgerService.recordUsage).not.toHaveBeenCalled();
    });

    it('never fails the ingest job when the ledger rejects (best-effort, like the chunk persistence)', async () => {
      const usageLedgerService = { recordUsage: vi.fn().mockRejectedValue(new Error('outbox unavailable')) };
      const { processor, knowledgeDocumentRepository, ingestClient, knowledgeChunkRepository } = buildHarness({ usageLedgerService });
      knowledgeDocumentRepository.findById.mockResolvedValue(buildDoc());
      ingestClient.ingest.mockResolvedValue(ingestResponse());

      const job = buildJob({ knowledgeDocumentId: 'doc-1', tenantId: TENANT_A, text: 'x' });
      await expect(processor.process(job as never)).resolves.toBeDefined();
      expect(knowledgeChunkRepository.create).toHaveBeenCalledTimes(2);
    });
  });
});
