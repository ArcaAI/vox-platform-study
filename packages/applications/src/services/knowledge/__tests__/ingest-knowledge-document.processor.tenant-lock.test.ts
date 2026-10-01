import { DelayedError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { IngestKnowledgeDocumentProcessor } from '../ingest-knowledge-document.processor';

function build(lockState: { locked: boolean; restoreId?: string; categories?: string[] }) {
  const knowledgeDocumentRepository = { findById: vi.fn(), update: vi.fn() };
  const cls = { run: vi.fn(async (fn: () => unknown) => fn()), set: vi.fn() };
  const tenantLock = { state: vi.fn().mockResolvedValue(lockState), publishChange: vi.fn() };
  const processor = new IngestKnowledgeDocumentProcessor(
    knowledgeDocumentRepository as never,
    { create: vi.fn() } as never,
    { ingest: vi.fn() } as never,
    cls as never,
    undefined,
    undefined,
    undefined,
    tenantLock as never,
  );
  return { processor, knowledgeDocumentRepository, cls, tenantLock };
}

const job = () => ({
  id: 'job-1',
  data: { jobId: 'job-1', knowledgeDocumentId: 'doc-1', tenantId: 'T', userId: 'u', text: 'x' },
  timestamp: Date.now(),
  updateProgress: vi.fn(),
  moveToDelayed: vi.fn().mockResolvedValue(undefined),
});

describe('IngestKnowledgeDocumentProcessor — tenant lock', () => {
  it('postpones the job and runs nothing while the tenant is locked', async () => {
    const { processor, knowledgeDocumentRepository, cls } = build({ locked: true, restoreId: 'R' });
    const j = job();
    await expect(processor.process(j as never, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(j.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok');
    expect(cls.run).not.toHaveBeenCalled();
    expect(knowledgeDocumentRepository.findById).not.toHaveBeenCalled();
  });

  it('conflicts with CONFIG_CONTENT only: postponed by it, not by a USERS_ACCESS / CLINICAL-only restore', async () => {
    const held = build({ locked: true, restoreId: 'R', categories: ['USERS_ACCESS', 'CONFIG_CONTENT'] });
    await expect(held.processor.process(job() as never, 'tok')).rejects.toBeInstanceOf(DelayedError);

    const free = build({ locked: true, restoreId: 'R', categories: ['USERS_ACCESS', 'CLINICAL'] });
    const j = job();
    await free.processor.process(j as never, 'tok').catch(() => undefined); // swallow-ok: the body may fail on bare mocks; only the postponement matters
    expect(j.moveToDelayed).not.toHaveBeenCalled();
  });

  it('runs the body when the tenant is unlocked', async () => {
    const { processor, knowledgeDocumentRepository } = build({ locked: false });
    knowledgeDocumentRepository.findById.mockResolvedValue(null);
    await expect(processor.process(job() as never, 'tok')).rejects.toThrow(/not found/);
    expect(knowledgeDocumentRepository.findById).toHaveBeenCalled();
  });
});
