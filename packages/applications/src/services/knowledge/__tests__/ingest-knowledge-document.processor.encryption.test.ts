/**
 * IngestKnowledgeDocumentProcessor encryption wiring.
 *
 * The processor is the SOLE TypeScript write path for KnowledgeChunk rows. This
 * test verifies each chunk's free-text `text` is encrypted into the
 * `encryptedText` column BEFORE the row is persisted, that encryption is
 * best-effort (a Vault outage still persists the plaintext chunk), and that
 * encryption is skipped entirely when no SecretsService is wired.
 *
 * Harness + SecretsService are mocked — no DB / Vault / real harness call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeDocumentStatus } from '@arcaai/domains';
import { IngestKnowledgeDocumentProcessor } from '../ingest-knowledge-document.processor';

const TENANT_A = 'tenant-A';

function buildDoc(overrides: Record<string, unknown> = {}) {
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

function buildHarness(withSecrets: boolean) {
  const knowledgeDocumentRepository = { findById: vi.fn(), update: vi.fn(async (_id: string, e: unknown) => e) };
  const knowledgeChunkRepository = {
    create: vi.fn(async (e: unknown) => e),
    encryptFieldsIntoEntity: vi.fn(async () => undefined),
  };
  const ingestClient = { ingest: vi.fn() };
  const cls = { run: vi.fn(async (fn: () => unknown) => fn()), set: vi.fn() };
  const secretsService = { encrypt: vi.fn(), decrypt: vi.fn() };

  const processor = new IngestKnowledgeDocumentProcessor(
    knowledgeDocumentRepository as never,
    knowledgeChunkRepository as never,
    ingestClient as never,
    cls as never,
    withSecrets ? (secretsService as never) : undefined,
  );

  return { processor, knowledgeDocumentRepository, knowledgeChunkRepository, ingestClient };
}

function buildJob(data: Record<string, unknown>) {
  return { id: 'job-1', data, timestamp: Date.now(), updateProgress: vi.fn() };
}

describe('IngestKnowledgeDocumentProcessor — field encryption', () => {
  beforeEach(() => vi.clearAllMocks());

  it('encrypts every chunk BEFORE persisting it', async () => {
    const { processor, knowledgeDocumentRepository, knowledgeChunkRepository, ingestClient } = buildHarness(true);
    knowledgeDocumentRepository.findById.mockResolvedValue(buildDoc());
    ingestClient.ingest.mockResolvedValue(ingestResponse());

    await processor.process(buildJob({ jobId: 'job-1', knowledgeDocumentId: 'doc-1', tenantId: TENANT_A, userId: 'admin-1', text: 'x' }) as never);

    expect(knowledgeChunkRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(2);
    expect(knowledgeChunkRepository.create).toHaveBeenCalledTimes(2);
    // first chunk: encrypt precedes its persist
    expect(knowledgeChunkRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0]).toBeLessThan(
      knowledgeChunkRepository.create.mock.invocationCallOrder[0],
    );
    // the SAME entity instance is encrypted then persisted
    expect(knowledgeChunkRepository.encryptFieldsIntoEntity.mock.calls[0][0]).toBe(knowledgeChunkRepository.create.mock.calls[0][0]);
  });

  it('still persists chunks when encryption fails (dual-write soak)', async () => {
    const { processor, knowledgeDocumentRepository, knowledgeChunkRepository, ingestClient } = buildHarness(true);
    knowledgeDocumentRepository.findById.mockResolvedValue(buildDoc());
    ingestClient.ingest.mockResolvedValue(ingestResponse());
    knowledgeChunkRepository.encryptFieldsIntoEntity.mockRejectedValue(new Error('vault down'));

    const result = await processor.process(buildJob({ knowledgeDocumentId: 'doc-1', tenantId: TENANT_A, text: 'x' }) as never);

    expect(knowledgeChunkRepository.create).toHaveBeenCalledTimes(2);
    expect(result.chunkCount).toBe(2);
  });

  it('does NOT encrypt when no SecretsService is wired', async () => {
    const { processor, knowledgeDocumentRepository, knowledgeChunkRepository, ingestClient } = buildHarness(false);
    knowledgeDocumentRepository.findById.mockResolvedValue(buildDoc());
    ingestClient.ingest.mockResolvedValue(ingestResponse());

    await processor.process(buildJob({ knowledgeDocumentId: 'doc-1', tenantId: TENANT_A, text: 'x' }) as never);

    expect(knowledgeChunkRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
    expect(knowledgeChunkRepository.create).toHaveBeenCalledTimes(2);
  });
});
