/**
 * TASK-890 L11 (§3.13) — institutional-RAG ingestion embedded documents and
 * RECORDED an `embed` row, but never asked whether the tenant had any
 * `monthlyEmbeddingTokens` allowance left. A tenant could ingest a corpus of
 * any size and meet the number afterwards.
 *
 * The check runs before the harness ingest call: the embedding is the cost,
 * and refusing after it has happened bills the work and then complains.
 */
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeDocumentStatus } from '@arcaai/domains';
import { IngestKnowledgeDocumentProcessor } from '../ingest-knowledge-document.processor';

const TENANT = 'tenant-A';

function build(entitlements?: unknown) {
  const document = {
    id: 'doc-1',
    tenantId: TENANT,
    title: 'Sepsis Protocol',
    source: 'protocols/sepsis.md',
    mimeType: 'text/markdown',
    status: KnowledgeDocumentStatus.APPROVED,
    chunkCount: 0,
    ingestedAt: null as Date | null,
    updatedBy: null as string | null,
    markIngested(count: number) {
      this.chunkCount = count;
    },
  };
  const knowledgeDocumentRepository = { findById: vi.fn(async () => document), update: vi.fn(async (_id: string, e: unknown) => e) };
  const knowledgeChunkRepository = { create: vi.fn(async (e: unknown) => e) };
  const ingestClient = {
    ingest: vi.fn(async () => ({
      chunkCount: 1,
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
      ],
    })),
  };
  const cls = { run: vi.fn(async (fn: () => unknown) => fn()), set: vi.fn() };
  const usageLedgerService = { recordUsage: vi.fn(async () => ({ outboxIds: ['o-1'], events: 1 })) };

  const processor = new IngestKnowledgeDocumentProcessor(
    knowledgeDocumentRepository as never,
    knowledgeChunkRepository as never,
    ingestClient as never,
    cls as never,
    undefined, // secretsService
    usageLedgerService as never,
    entitlements as never,
  );
  const job = { id: 'job-1', data: { jobId: 'j-1', knowledgeDocumentId: 'doc-1', tenantId: TENANT, text: 'body' }, updateProgress: vi.fn() };
  return { processor, job, ingestClient, usageLedgerService };
}

describe('IngestKnowledgeDocumentProcessor — the embedding allowance (TASK-890)', () => {
  it('prechecks `monthlyEmbeddingTokens` for the job tenant before the ingest call', async () => {
    const entitlements = { assertMeterQuota: vi.fn(async () => undefined) };
    const { processor, job, ingestClient } = build(entitlements);

    await processor.process(job as never);

    expect(entitlements.assertMeterQuota).toHaveBeenCalledWith(TENANT, 'monthlyEmbeddingTokens');
    expect(entitlements.assertMeterQuota.mock.invocationCallOrder[0]).toBeLessThan(ingestClient.ingest.mock.invocationCallOrder[0]);
  });

  it('refuses the job on an exhausted allowance — nothing is embedded and nothing is billed', async () => {
    const entitlements = { assertMeterQuota: vi.fn().mockRejectedValue(new Error('over allowance')) };
    const { processor, job, ingestClient, usageLedgerService } = build(entitlements);

    await expect(processor.process(job as never)).rejects.toThrow('over allowance');
    expect(ingestClient.ingest).not.toHaveBeenCalled();
    expect(usageLedgerService.recordUsage).not.toHaveBeenCalled();
  });

  it('ingests normally when no entitlements service is wired (metering is additive)', async () => {
    const { processor, job, ingestClient } = build(undefined);
    await expect(processor.process(job as never)).resolves.toMatchObject({ chunkCount: 1 });
    expect(ingestClient.ingest).toHaveBeenCalledTimes(1);
  });
});
