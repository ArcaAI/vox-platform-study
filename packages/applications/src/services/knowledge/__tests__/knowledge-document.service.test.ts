/**
 * KnowledgeDocumentService unit tests — institutional RAG.
 *
 * Data-layer + approval-workflow service: builds the tenant-scoped
 * KnowledgeDocument via the domain factory, persists through the repository,
 * and on approval enqueues the BullMQ IngestKnowledgeDocument job carrying the
 * raw text (which is NOT persisted on the row — only its checksum is).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { JobQueue, KnowledgeDocumentStatus, KnowledgeDocumentFactory } from '@arcaai/domains';
import { KnowledgeDocumentService } from '../knowledge-document.service';

const TENANT_A = 'tenant-A';

function buildService() {
  const knowledgeDocumentRepository = {
    create: vi.fn(async (e) => e),
    findById: vi.fn(),
    findAll: vi.fn(),
    update: vi.fn(async (_id, e) => e),
  };
  const ingestQueue = { add: vi.fn() };
  const service = new KnowledgeDocumentService(knowledgeDocumentRepository as never, ingestQueue as never);
  return { service, knowledgeDocumentRepository, ingestQueue };
}

describe('KnowledgeDocumentService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers a DRAFT document scoped to the tenant', async () => {
    const { service, knowledgeDocumentRepository } = buildService();

    const doc = await service.registerDocument({
      tenantId: TENANT_A,
      title: 'Sepsis Protocol',
      source: 'protocols/sepsis.md',
      sourceType: 'markdown',
      mimeType: 'text/markdown',
      checksum: 'sha256:abc',
      createdBy: 'admin-1',
    });

    expect(knowledgeDocumentRepository.create).toHaveBeenCalledTimes(1);
    expect(doc.tenantId).toBe(TENANT_A);
    expect(doc.status).toBe(KnowledgeDocumentStatus.DRAFT);
    expect(doc.title).toBe('Sepsis Protocol');
    expect(doc.checksum).toBe('sha256:abc');
  });

  it('approves a document and enqueues the ingest job with the raw text', async () => {
    const { service, knowledgeDocumentRepository, ingestQueue } = buildService();
    const existing = KnowledgeDocumentFactory.CreateKnowledgeDocument({
      tenantId: TENANT_A,
      title: 'Sepsis Protocol',
      source: 'protocols/sepsis.md',
      sourceType: 'markdown',
      mimeType: 'text/markdown',
      checksum: 'sha256:abc',
    });
    knowledgeDocumentRepository.findById.mockResolvedValue(existing);

    const updated = await service.approveDocument(existing.id, {
      tenantId: TENANT_A,
      approvedBy: 'admin-1',
      text: 'Give antibiotics within 1 hour.',
      jobId: 'job-xyz',
    });

    expect(updated.status).toBe(KnowledgeDocumentStatus.APPROVED);
    expect(updated.approvedBy).toBe('admin-1');
    expect(updated.approvedAt).toBeInstanceOf(Date);
    expect(knowledgeDocumentRepository.update).toHaveBeenCalledWith(existing.id, existing);

    expect(ingestQueue.add).toHaveBeenCalledTimes(1);
    const [jobName, payload, opts] = ingestQueue.add.mock.calls[0];
    expect(jobName).toBe(JobQueue.IngestKnowledgeDocument);
    expect(payload).toMatchObject({
      knowledgeDocumentId: existing.id,
      tenantId: TENANT_A,
      userId: 'admin-1',
      text: 'Give antibiotics within 1 hour.',
    });
    expect(opts).toMatchObject({ jobId: 'job-xyz' });
  });

  it('refuses to approve a document owned by another tenant (no enqueue)', async () => {
    const { service, knowledgeDocumentRepository, ingestQueue } = buildService();
    const foreign = KnowledgeDocumentFactory.CreateKnowledgeDocument({
      tenantId: 'tenant-B',
      title: 'Other',
      source: 's',
      sourceType: 'markdown',
      mimeType: 'text/markdown',
      checksum: 'c',
    });
    knowledgeDocumentRepository.findById.mockResolvedValue(foreign);

    await expect(
      service.approveDocument(foreign.id, { tenantId: TENANT_A, text: 'x' }),
    ).rejects.toThrow(NotFoundException);
    expect(ingestQueue.add).not.toHaveBeenCalled();
  });

  it('throws NotFound when approving a missing document', async () => {
    const { service, knowledgeDocumentRepository, ingestQueue } = buildService();
    knowledgeDocumentRepository.findById.mockResolvedValue(null);

    await expect(service.approveDocument('missing', { tenantId: TENANT_A, text: 'x' })).rejects.toThrow(NotFoundException);
    expect(ingestQueue.add).not.toHaveBeenCalled();
  });
});
