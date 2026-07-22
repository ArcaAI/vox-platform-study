/**
 * Institutional-RAG domain layer.
 *
 * Proves the additive KnowledgeDocument / KnowledgeChunk models are threaded
 * through the domain layer (enum ⇄ entity ⇄ factory ⇄ data-model mapper) so the
 * ingestion services + repositories can read/write them:
 *
 *   • KnowledgeDocumentStatus enum (DRAFT / APPROVED / ARCHIVED)
 *   • KnowledgeDocument lifecycle (approve, markIngested) + factory defaults
 *   • KnowledgeChunk vector-provenance fields (qdrantPointId, offsets, embedding)
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeDocumentStatus } from '../enums';
import { KnowledgeDocumentFactory } from '../factories/generated/core/KnowledgeDocumentFactory';
import { KnowledgeChunkFactory } from '../factories/generated/core/KnowledgeChunkFactory';
import { KnowledgeDocumentEntityMapper } from '../mappers/generated/core/KnowledgeDocumentEntityMapper';
import { KnowledgeChunkEntityMapper } from '../mappers/generated/core/KnowledgeChunkEntityMapper';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

describe('Phase 3 — KnowledgeDocumentStatus enum', () => {
  it('has exactly the 3 lifecycle states', () => {
    expect(new Set(Object.values(KnowledgeDocumentStatus))).toEqual(new Set(['DRAFT', 'APPROVED', 'ARCHIVED']));
  });
});

describe('Phase 3 — KnowledgeDocument entity/factory', () => {
  const baseProps = {
    tenantId: TENANT_ID,
    title: 'Sepsis Bundle Protocol',
    source: 'protocols/sepsis-v3.md',
    sourceType: 'markdown',
    mimeType: 'text/markdown',
    checksum: 'sha256:abc123',
  };

  it('factory defaults status to DRAFT and chunkCount to 0', () => {
    const doc = KnowledgeDocumentFactory.CreateKnowledgeDocument(baseProps);
    expect(doc.status).toBe(KnowledgeDocumentStatus.DRAFT);
    expect(doc.chunkCount).toBe(0);
    expect(doc.approvedBy).toBeNull();
    expect(doc.approvedAt).toBeNull();
    expect(doc.ingestedAt).toBeNull();
    expect(doc.isApproved).toBe(false);
    expect(doc.tenantId).toBe(TENANT_ID);
    expect(doc.id).toBeTruthy();
  });

  it('factory threads the business fields', () => {
    const doc = KnowledgeDocumentFactory.CreateKnowledgeDocument(baseProps);
    expect(doc.title).toBe('Sepsis Bundle Protocol');
    expect(doc.source).toBe('protocols/sepsis-v3.md');
    expect(doc.sourceType).toBe('markdown');
    expect(doc.mimeType).toBe('text/markdown');
    expect(doc.checksum).toBe('sha256:abc123');
  });

  it('approve() transitions DRAFT -> APPROVED and stamps approver + time', () => {
    const doc = KnowledgeDocumentFactory.CreateKnowledgeDocument(baseProps);
    doc.approve('clinician-1');
    expect(doc.status).toBe(KnowledgeDocumentStatus.APPROVED);
    expect(doc.approvedBy).toBe('clinician-1');
    expect(doc.approvedAt).toBeInstanceOf(Date);
    expect(doc.isApproved).toBe(true);
  });

  it('markIngested() stamps ingestedAt + chunkCount', () => {
    const doc = KnowledgeDocumentFactory.CreateKnowledgeDocument(baseProps);
    doc.markIngested(7);
    expect(doc.chunkCount).toBe(7);
    expect(doc.ingestedAt).toBeInstanceOf(Date);
  });

  it('validate() requires title/source/checksum', () => {
    expect(() => KnowledgeDocumentFactory.CreateKnowledgeDocument({ ...baseProps, title: '' }).validate()).toThrow(/title/i);
    expect(() => KnowledgeDocumentFactory.CreateKnowledgeDocument({ ...baseProps, source: '' }).validate()).toThrow(/source/i);
    expect(() => KnowledgeDocumentFactory.CreateKnowledgeDocument({ ...baseProps, checksum: '' }).validate()).toThrow(/checksum/i);
  });

  it('mapper round-trips status + ingestion fields (entity -> model -> entity)', () => {
    const mapper = new KnowledgeDocumentEntityMapper();
    const doc = KnowledgeDocumentFactory.CreateKnowledgeDocument(baseProps);
    doc.approve('clinician-9');
    doc.markIngested(3);

    const model = mapper.toPersistence(doc);
    expect(model.status).toBe(KnowledgeDocumentStatus.APPROVED);
    expect(model.chunkCount).toBe(3);
    expect(model.approvedBy).toBe('clinician-9');

    const back = mapper.toDomainEntity(model);
    expect(back.status).toBe(KnowledgeDocumentStatus.APPROVED);
    expect(back.chunkCount).toBe(3);
    expect(back.approvedBy).toBe('clinician-9');
    expect(back.isApproved).toBe(true);
  });
});

describe('Phase 3 — KnowledgeChunk entity/factory', () => {
  const chunkProps = {
    tenantId: TENANT_ID,
    knowledgeDocumentId: 'doc-1',
    chunkIndex: 0,
    text: 'Administer broad-spectrum antibiotics within 1 hour.',
    tokenCount: 9,
    startOffset: 0,
    endOffset: 52,
    qdrantPointId: 'pt-0001',
    embeddingModel: 'BAAI/bge-m3',
    embeddingDim: 1024,
    status: 'APPROVED',
  };

  it('factory threads chunk + vector-provenance fields', () => {
    const chunk = KnowledgeChunkFactory.CreateKnowledgeChunk(chunkProps);
    expect(chunk.knowledgeDocumentId).toBe('doc-1');
    expect(chunk.chunkIndex).toBe(0);
    expect(chunk.text).toBe('Administer broad-spectrum antibiotics within 1 hour.');
    expect(chunk.tokenCount).toBe(9);
    expect(chunk.startOffset).toBe(0);
    expect(chunk.endOffset).toBe(52);
    expect(chunk.qdrantPointId).toBe('pt-0001');
    expect(chunk.embeddingModel).toBe('BAAI/bge-m3');
    expect(chunk.embeddingDim).toBe(1024);
    expect(chunk.status).toBe('APPROVED');
    expect(chunk.tenantId).toBe(TENANT_ID);
    expect(chunk.id).toBeTruthy();
  });

  it('validate() requires knowledgeDocumentId + qdrantPointId + text', () => {
    expect(() => KnowledgeChunkFactory.CreateKnowledgeChunk({ ...chunkProps, knowledgeDocumentId: '' }).validate()).toThrow(/knowledgeDocumentId/i);
    expect(() => KnowledgeChunkFactory.CreateKnowledgeChunk({ ...chunkProps, qdrantPointId: '' }).validate()).toThrow(/qdrantPointId/i);
    expect(() => KnowledgeChunkFactory.CreateKnowledgeChunk({ ...chunkProps, text: '' }).validate()).toThrow(/text/i);
  });

  it('mapper round-trips the chunk (entity -> model -> entity)', () => {
    const mapper = new KnowledgeChunkEntityMapper();
    const chunk = KnowledgeChunkFactory.CreateKnowledgeChunk(chunkProps);
    const model = mapper.toPersistence(chunk);
    expect(model.qdrantPointId).toBe('pt-0001');
    expect(model.embeddingDim).toBe(1024);

    const back = mapper.toDomainEntity(model);
    expect(back.qdrantPointId).toBe('pt-0001');
    expect(back.embeddingDim).toBe(1024);
    expect(back.chunkIndex).toBe(0);
    expect(back.status).toBe('APPROVED');
  });
});
