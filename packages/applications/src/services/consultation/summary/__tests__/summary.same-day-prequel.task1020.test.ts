/**
 * TASK-1020 — the warm-start PRE-SUMMARY carries the same-day prequel and the client's lab results.
 *
 * The pre-summary of an afternoon return visit is where the morning's note and the labs taken in
 * between belong most of all: it is the clinician's briefing before the patient walks back in.
 * Assertions are on what reaches `PromptAssemblyService.assemble`, the seam every native pre-summary
 * entry point converges on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextItemType } from '@arcaai/domains';

import { SummaryService } from '../summary.service';

const CID = 'c-afternoon';
const PARENT = 'c-morning';
const TENANT = 'tenant-1020';
const PATIENT = 'patient-1020';
const DAY = new Date('2026-09-29T00:00:00.000Z');

interface Wiring {
  parentConsultationId?: string | null;
  parentDay?: Date;
  investigations?: unknown;
}

function buildService(wiring: Wiring = {}) {
  const assemble = vi
    .fn()
    .mockResolvedValue({ userPrompt: 'assembled', systemPrompt: '', hyperparameters: {}, responseFormat: null, resolvedFrom: 'tenant' });

  const contextItemRepository = {
    findCaseNotes: vi.fn(async () => [{ id: 'cn-1', content: 'Morning labs ordered: CBC, LFT.' }]),
    findByType: vi.fn(async (consultationId: string, type: ContextItemType) =>
      consultationId === PARENT && type === ContextItemType.SIGNED_NOTE ? [{ content: 'MORNING-SIGNED plan: CBC, LFT', createdAt: new Date() }] : [],
    ),
    findLatestByKindKey: vi.fn(async (_cid: string, kindKey: string) =>
      kindKey === 'investigations' && wiring.investigations !== undefined
        ? { id: 'ci-inv', kindKey, content: JSON.stringify(wiring.investigations), createdAt: new Date() }
        : null,
    ),
    findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null, plaintext: null })),
    create: vi.fn(async (entity: unknown) => ({ ...(entity as object), id: 'ctx-new', createdAt: new Date(), updatedAt: new Date() })),
    encryptContentIntoEntity: vi.fn(),
  };

  const consultationRepository = {
    findById: vi.fn(async (id: string) => {
      if (id === CID) {
        return {
          id: CID,
          tenantId: TENANT,
          patientId: PATIENT,
          appointmentDate: DAY,
          doctorId: 'doctor-1',
          departmentId: 'dept-1',
          parentConsultationId: wiring.parentConsultationId === undefined ? PARENT : wiring.parentConsultationId,
          metadata: null,
        };
      }
      if (id === PARENT) {
        return {
          id: PARENT,
          tenantId: TENANT,
          patientId: PATIENT,
          appointmentDate: wiring.parentDay ?? DAY,
          parentConsultationId: null,
          status: 'SIGNED',
          createdAt: new Date('2026-09-29T04:15:00.000Z'),
        };
      }
      throw new Error('DataNotFound');
    }),
  };

  const service = new SummaryService(
    contextItemRepository as never,
    consultationRepository as never,
    { create: vi.fn(), encryptFieldsIntoEntity: vi.fn() } as never,
    { create: vi.fn() } as never,
    { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'generated', modelName: 'm' } }) } } as never,
    { get: vi.fn((k: string) => (k === 'TEXT_URL' ? 'http://text' : k === 'NLP_URL' ? 'http://nlp' : undefined)) } as never,
    { emit: vi.fn() } as never,
    { get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : k === 'user' ? { id: 'user-1' } : null)), set: vi.fn() } as never,
    { create: vi.fn(), encryptFieldsIntoEntity: vi.fn() } as never,
    { assemble } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'm' }) } as never,
  );

  return { service, assemble };
}

const paramsOf = (assemble: ReturnType<typeof vi.fn>) => assemble.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

describe('TASK-1020 — generatePreSummary hands the same-day prequel and test results to assembly', () => {
  it('passes the morning note as sameDayPrequelSummary', async () => {
    const { service, assemble } = buildService();

    await service.generatePreSummary(CID, {} as never);

    expect(paramsOf(assemble).sameDayPrequelSummary).toBe('### Earlier visit today (04:15 UTC, status SIGNED)\nMORNING-SIGNED plan: CBC, LFT');
  });

  it('omits it for a parent from another day', async () => {
    const { service, assemble } = buildService({ parentDay: new Date('2026-09-01T00:00:00.000Z') });

    await service.generatePreSummary(CID, {} as never);

    expect(paramsOf(assemble)).not.toHaveProperty('sameDayPrequelSummary');
  });

  it('omits it for a first visit', async () => {
    const { service, assemble } = buildService({ parentConsultationId: null });

    await service.generatePreSummary(CID, {} as never);

    expect(paramsOf(assemble)).not.toHaveProperty('sameDayPrequelSummary');
  });

  it('passes the investigations as testResults, and omits the key when none were sent', async () => {
    const withResults = buildService({ investigations: { results: [{ name: 'ALT', value: 88, unit: 'U/L', refRange: '7-56', flag: 'H' }] } });
    await withResults.service.generatePreSummary(CID, {} as never);
    expect(paramsOf(withResults.assemble).testResults).toBe('- ALT: 88 U/L (ref 7-56) [H]');

    const without = buildService();
    await without.service.generatePreSummary(CID, {} as never);
    expect(paramsOf(without.assemble)).not.toHaveProperty('testResults');
  });
});
