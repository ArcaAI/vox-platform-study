// MUST be first — the package barrel reproduces the production evaluation order (see chain-summary.agent-plane.task1006).
import '../../../../index';
/**
 * The comprehensive summary is a note of the REQUESTING consultation, written in its current
 * encounter, so the RAW_SUMMARY it stores carries that encounter.
 */
import { describe, expect, it, vi } from 'vitest';
import { ChainSummaryService } from '../chain-summary.service';

const TENANT = 'tenant-1';

function build(guardrailNotices: unknown[] = []) {
  const consultation = {
    id: 'c-1',
    tenantId: TENANT,
    patientId: 'pat-1',
    doctorId: 'doc-1',
    departmentId: 'dept-1',
    parentConsultationId: null,
    metadata: null,
    currentEncounterSeq: 2,
    Department: { name: 'Cardiology' },
    Doctor: { username: 'dr.a' },
  };
  const contextItemRepository = {
    findById: vi.fn(),
    findTranscripts: vi.fn().mockResolvedValue([]),
    findSummaries: vi.fn().mockResolvedValue([{ id: 's-1', content: 'Chest pain, resolved.', currentVersionNumber: 4, createdAt: new Date() }]),
    findCaseNotes: vi.fn().mockResolvedValue([{ id: 'cn-1', content: 'Smoker.', currentVersionNumber: 1, createdAt: new Date() }]),
    findPreSummaries: vi.fn().mockResolvedValue([{ id: 'ps-1', content: '   ', currentVersionNumber: 1, createdAt: new Date() }]),
    findSharedContext: vi.fn().mockResolvedValue([]),
    create: vi
      .fn()
      .mockImplementation((item: { id: string; consultationId: string; type: string }) =>
        Promise.resolve({ id: item.id, consultationId: item.consultationId, type: item.type, createdAt: new Date(), updatedAt: new Date() }),
      ),
    encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
    setGuardrailStatus: vi.fn().mockResolvedValue(undefined),
  };
  const invokeText = vi
    .fn()
    .mockResolvedValue({ text: 'Note.', provider: 'p', model: 'm', usage: null, usageDetail: null, promptFragments: null, guardrailNotices });
  const service = new ChainSummaryService(
    contextItemRepository as never,
    {
      findById: vi.fn().mockResolvedValue(consultation),
      findConsultationChain: vi.fn().mockResolvedValue([consultation]),
      findByPatientAndDate: vi.fn().mockResolvedValue([consultation]),
    } as never,
    { create: vi.fn().mockResolvedValue({ id: 'meta-1' }), encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined) } as never,
    { findByContextItem: vi.fn().mockResolvedValue([]) } as never,
    { emit: vi.fn() } as never,
    {
      get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'doc-1' } : null)),
      set: vi.fn(),
      run: vi.fn((cb: () => unknown) => cb()),
    } as never,
    { resolve: vi.fn().mockResolvedValue({ slug: 'general-medicine-summarization', task: 'TEXT_GENERATION' }) } as never,
    { invokeText } as never,
    { getSecretOptional: vi.fn().mockResolvedValue('') } as never,
  );

  return { service, invokeText, contextItemRepository };
}

describe('ChainSummaryService — the encounter the note was written in', () => {
  it('stamps the RAW_SUMMARY with the requesting consultation’s current encounter', async () => {
    const { service, contextItemRepository } = build();
    await service.generateComprehensiveSummary('c-1', { includeNER: false });

    const [created] = contextItemRepository.create.mock.calls[0] as unknown as [{ type: string; encounterSeq?: number | null }];
    expect(created.type).toBe('RAW_SUMMARY');
    expect(created.encounterSeq).toBe(2);
  });
});
