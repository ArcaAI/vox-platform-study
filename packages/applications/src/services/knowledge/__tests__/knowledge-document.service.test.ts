/**
 * KnowledgeDocumentService unit tests — institutional RAG (TASK-728).
 *
 * The service now follows the standard application-service pattern
 * (`extends BaseService`, symbol-token DI, sys-event broadcasts on every
 * mutation and on forced-audited reads). Covers:
 *
 *  - registerDocument/approveDocument still work and now broadcast sys-events
 *  - a NEW archiveDocument(id): status -> ARCHIVED, ResourceUpdated
 *  - a NEW deleteDocument(id): fail-closed Qdrant vector cleanup BEFORE the
 *    Postgres soft-delete; ResourceDeleted only on success
 *  - a NEW listChunks(documentId): paginated, decrypted text, forced-audited
 *    ResourceViewed
 *  - cross-tenant ids on every by-id path answer 404, never 403
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { InternalServerErrorException } from '@arcaai/exceptions';
import { JobQueue, KnowledgeDocumentStatus, KnowledgeDocumentFactory, KnowledgeChunkFactory } from '@arcaai/domains';
import { KnowledgeDocumentService } from '../knowledge-document.service';

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

function buildService() {
  const knowledgeDocumentRepository = {
    create: vi.fn(async (e) => e),
    findById: vi.fn(),
    findAll: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    update: vi.fn(async (_id, e) => e),
    softDelete: vi.fn(),
  };
  const knowledgeChunkRepository = {
    findAll: vi.fn(async () => []),
    count: vi.fn(async () => 0),
  };
  const ingestQueue = { add: vi.fn() };
  const vectorCleanupClient = { deleteByDocument: vi.fn(async () => undefined) };

  mockClsService.get.mockImplementation((key: string) => {
    switch (key) {
      case 'user':
        return { id: 'user-1', roles: ['TENANT_ADMIN'] };
      case 'tenantId':
        return TENANT_A;
      default:
        return undefined;
    }
  });

  const service = new KnowledgeDocumentService(
    knowledgeDocumentRepository as never,
    knowledgeChunkRepository as never,
    ingestQueue as never,
    vectorCleanupClient as never,
    mockEventEmitter as never,
    mockClsService as never,
  );
  return { service, knowledgeDocumentRepository, knowledgeChunkRepository, ingestQueue, vectorCleanupClient };
}

function foreignDocument() {
  return KnowledgeDocumentFactory.CreateKnowledgeDocument({
    tenantId: TENANT_B,
    title: 'Other',
    source: 's',
    sourceType: 'markdown',
    mimeType: 'text/markdown',
    checksum: 'c',
  });
}

describe('KnowledgeDocumentService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('registerDocument', () => {
    it('registers a DRAFT document scoped to the tenant and broadcasts ResourceCreated', async () => {
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

      expect(mockEventEmitter.emit).toHaveBeenCalledWith('SysEvent.ResourceCreated', expect.objectContaining({ resourceId: doc.id }));
    });
  });

  describe('approveDocument', () => {
    it('approves a document, enqueues the ingest job, and broadcasts ResourceUpdated', async () => {
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

      expect(mockEventEmitter.emit).toHaveBeenCalledWith('SysEvent.ResourceUpdated', expect.objectContaining({ resourceId: existing.id }));
    });

    it('refuses to approve a document owned by another tenant (404, no enqueue)', async () => {
      const { service, knowledgeDocumentRepository, ingestQueue } = buildService();
      const foreign = foreignDocument();
      knowledgeDocumentRepository.findById.mockResolvedValue(foreign);

      await expect(service.approveDocument(foreign.id, { tenantId: TENANT_A, text: 'x' })).rejects.toThrow(NotFoundException);
      expect(ingestQueue.add).not.toHaveBeenCalled();
    });

    it('throws NotFound when approving a missing document', async () => {
      const { service, knowledgeDocumentRepository, ingestQueue } = buildService();
      knowledgeDocumentRepository.findById.mockResolvedValue(null);

      await expect(service.approveDocument('missing', { tenantId: TENANT_A, text: 'x' })).rejects.toThrow(NotFoundException);
      expect(ingestQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('getDocument', () => {
    it('returns the document and broadcasts a FORCED-audited ResourceViewed', async () => {
      const { service, knowledgeDocumentRepository } = buildService();
      const existing = KnowledgeDocumentFactory.CreateKnowledgeDocument({
        tenantId: TENANT_A,
        title: 'Sepsis Protocol',
        source: 's',
        sourceType: 'markdown',
        mimeType: 'text/markdown',
        checksum: 'c',
      });
      knowledgeDocumentRepository.findById.mockResolvedValue(existing);

      const result = await service.getDocument(existing.id);

      expect(result.id).toBe(existing.id);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'SysEvent.ResourceViewed',
        expect.objectContaining({ resourceId: existing.id, forceAuditLog: true }),
      );
    });

    it('404s on a cross-tenant document id (never 403)', async () => {
      const { service, knowledgeDocumentRepository } = buildService();
      knowledgeDocumentRepository.findById.mockResolvedValue(foreignDocument());

      await expect(service.getDocument('foreign-id')).rejects.toThrow(NotFoundException);
    });

    it('404s on a missing document id', async () => {
      const { service, knowledgeDocumentRepository } = buildService();
      knowledgeDocumentRepository.findById.mockResolvedValue(null);

      await expect(service.getDocument('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('listDocuments', () => {
    it('lists the caller tenant documents paginated', async () => {
      const { service, knowledgeDocumentRepository } = buildService();
      const doc = KnowledgeDocumentFactory.CreateKnowledgeDocument({
        tenantId: TENANT_A,
        title: 'A',
        source: 's',
        sourceType: 'markdown',
        mimeType: 'text/markdown',
        checksum: 'c',
      });
      knowledgeDocumentRepository.findAll.mockResolvedValue([doc]);
      knowledgeDocumentRepository.count.mockResolvedValue(1);

      const result = await service.listDocuments({ page: 0, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.count).toBe(1);
    });
  });

  describe('archiveDocument', () => {
    it('moves status to ARCHIVED and broadcasts ResourceUpdated', async () => {
      const { service, knowledgeDocumentRepository } = buildService();
      const existing = KnowledgeDocumentFactory.CreateKnowledgeDocument({
        tenantId: TENANT_A,
        title: 'A',
        source: 's',
        sourceType: 'markdown',
        mimeType: 'text/markdown',
        checksum: 'c',
        status: KnowledgeDocumentStatus.APPROVED,
      });
      knowledgeDocumentRepository.findById.mockResolvedValue(existing);

      const result = await service.archiveDocument(existing.id);

      expect(result.status).toBe(KnowledgeDocumentStatus.ARCHIVED);
      expect(knowledgeDocumentRepository.update).toHaveBeenCalledWith(existing.id, existing);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith('SysEvent.ResourceUpdated', expect.objectContaining({ resourceId: existing.id }));
    });

    it('404s on a cross-tenant document id', async () => {
      const { service, knowledgeDocumentRepository } = buildService();
      knowledgeDocumentRepository.findById.mockResolvedValue(foreignDocument());

      await expect(service.archiveDocument('foreign-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteDocument — fail-closed Qdrant ordering', () => {
    it('calls Qdrant vector cleanup BEFORE the Postgres soft-delete, then broadcasts ResourceDeleted', async () => {
      const { service, knowledgeDocumentRepository, vectorCleanupClient } = buildService();
      const existing = KnowledgeDocumentFactory.CreateKnowledgeDocument({
        tenantId: TENANT_A,
        title: 'A',
        source: 's',
        sourceType: 'markdown',
        mimeType: 'text/markdown',
        checksum: 'c',
      });
      knowledgeDocumentRepository.findById.mockResolvedValue(existing);
      knowledgeDocumentRepository.softDelete.mockResolvedValue(existing);

      const callOrder: string[] = [];
      vectorCleanupClient.deleteByDocument.mockImplementation(async () => {
        callOrder.push('qdrant');
      });
      knowledgeDocumentRepository.softDelete.mockImplementation(async () => {
        callOrder.push('postgres');
        return existing;
      });

      await service.deleteDocument(existing.id);

      expect(vectorCleanupClient.deleteByDocument).toHaveBeenCalledWith({ tenantId: TENANT_A, knowledgeDocumentId: existing.id });
      expect(knowledgeDocumentRepository.softDelete).toHaveBeenCalledWith(existing.id, expect.anything());
      expect(callOrder).toEqual(['qdrant', 'postgres']);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith('SysEvent.ResourceDeleted', expect.objectContaining({ resourceId: existing.id }));
    });

    it('ABORTS the delete (no Postgres soft-delete, no ResourceDeleted) when Qdrant cleanup fails', async () => {
      const { service, knowledgeDocumentRepository, vectorCleanupClient } = buildService();
      const existing = KnowledgeDocumentFactory.CreateKnowledgeDocument({
        tenantId: TENANT_A,
        title: 'A',
        source: 's',
        sourceType: 'markdown',
        mimeType: 'text/markdown',
        checksum: 'c',
      });
      knowledgeDocumentRepository.findById.mockResolvedValue(existing);
      vectorCleanupClient.deleteByDocument.mockRejectedValue(new Error('harness unreachable'));

      await expect(service.deleteDocument(existing.id)).rejects.toThrow(InternalServerErrorException);

      expect(knowledgeDocumentRepository.softDelete).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith('SysEvent.ResourceDeleted', expect.anything());
    });

    it('404s on a cross-tenant document id (no Qdrant call, no leak)', async () => {
      const { service, knowledgeDocumentRepository, vectorCleanupClient } = buildService();
      knowledgeDocumentRepository.findById.mockResolvedValue(foreignDocument());

      await expect(service.deleteDocument('foreign-id')).rejects.toThrow(NotFoundException);
      expect(vectorCleanupClient.deleteByDocument).not.toHaveBeenCalled();
    });
  });

  describe('listChunks', () => {
    it('returns paginated, chunkIndex-ordered chunks and broadcasts a FORCED-audited ResourceViewed', async () => {
      const { service, knowledgeDocumentRepository, knowledgeChunkRepository } = buildService();
      const doc = KnowledgeDocumentFactory.CreateKnowledgeDocument({
        tenantId: TENANT_A,
        title: 'A',
        source: 's',
        sourceType: 'markdown',
        mimeType: 'text/markdown',
        checksum: 'c',
      });
      knowledgeDocumentRepository.findById.mockResolvedValue(doc);

      const chunk = KnowledgeChunkFactory.CreateKnowledgeChunk({
        tenantId: TENANT_A,
        knowledgeDocumentId: doc.id,
        chunkIndex: 0,
        text: 'decrypted chunk text',
        tokenCount: 10,
        startOffset: 0,
        endOffset: 20,
        qdrantPointId: 'pt-1',
        embeddingModel: 'model-x',
        embeddingDim: 4,
        status: 'APPROVED',
      });
      knowledgeChunkRepository.findAll.mockResolvedValue([chunk]);
      knowledgeChunkRepository.count.mockResolvedValue(1);

      const result = await service.listChunks(doc.id, { page: 0, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].text).toBe('decrypted chunk text');
      expect(result.data[0].qdrantPointId).toBe('pt-1');
      // Never leaks the ciphertext column.
      expect(result.data[0]).not.toHaveProperty('encryptedText');

      const [findAllArgs] = knowledgeChunkRepository.findAll.mock.calls[0];
      expect(findAllArgs).toMatchObject({ where: { knowledgeDocumentId: doc.id } });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'SysEvent.ResourceViewed',
        expect.objectContaining({ resourceId: doc.id, forceAuditLog: true }),
      );
    });

    it('404s on a cross-tenant document id (no chunk repository call, no leak)', async () => {
      const { service, knowledgeDocumentRepository, knowledgeChunkRepository } = buildService();
      knowledgeDocumentRepository.findById.mockResolvedValue(foreignDocument());

      await expect(service.listChunks('foreign-id', {})).rejects.toThrow(NotFoundException);
      expect(knowledgeChunkRepository.findAll).not.toHaveBeenCalled();
    });
  });
});
