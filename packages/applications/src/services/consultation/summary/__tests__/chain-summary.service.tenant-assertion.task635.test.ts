/**
 * ChainSummaryService — explicit tenant assertion
 *
 * The text selection used to be resolved with NO tenantId, relying on a CLS
 * fallback — a worker/CLS-less caller could silently be served the SYSTEM
 * default model instead of the tenant's. The service resolves `this.tenantId`
 * (BaseService CLS getter) EXPLICITLY and throws
 * `BadRequestException('Tenant ID is required')` when absent.
 *
 * TASK-1006 — the generation runs on the agent plane now, so the pin is on the
 * AGENT resolution: it is asked for the tenant that owns the consultation, and
 * with no tenant it is never asked at all.
 */

import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ChainSummaryService } from '../chain-summary.service';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ContextItemFactory: {
      CreateRawSummary: vi.fn((tenantId, consultationId, content, dnaStyleId, createdBy) => ({
        id: 'ctx-comprehensive-1',
        tenantId,
        consultationId,
        content,
        dnaWritingStyleId: dnaStyleId,
        type: 'RAW_SUMMARY',
        createdBy,
        createdAt: new Date('2026-02-17T10:00:00Z'),
        updatedAt: new Date('2026-02-17T10:00:00Z'),
      })),
    },
    SummaryMetaFactory: { CreateSummaryMeta: vi.fn((props) => ({ id: 'meta-1', ...props })) },
  };
});

const createConsultation = (overrides: Record<string, unknown> = {}) => ({
  id: 'consultation-A',
  tenantId: 'tenant-1',
  patientId: 'patient-1',
  doctorId: 'doctor-A',
  departmentId: 'dept-general',
  appointmentDate: new Date('2026-02-17'),
  parentConsultationId: null,
  metadata: null,
  Doctor: { username: 'Dr. A' },
  Department: { name: 'General Medicine' },
  ...overrides,
});

const createContextItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'ctx-1',
  consultationId: 'consultation-A',
  type: 'TRANSCRIPT',
  content: 'Patient presents with headache.',
  createdAt: new Date('2026-02-17T09:00:00Z'),
  ...overrides,
});

function createService(clsTenantId: string | null) {
  const contextItemRepo = {
    findById: vi.fn(),
    findTranscripts: vi.fn().mockResolvedValue([]),
    findSummaries: vi.fn().mockResolvedValue([createContextItem({ content: 'Findings.' })]),
    findCaseNotes: vi.fn().mockResolvedValue([]),
    findPreSummaries: vi.fn().mockResolvedValue([]),
    findSharedContext: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockImplementation((item) => Promise.resolve(item)),
    encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const consultation = createConsultation();
  const consultationRepo = {
    findById: vi.fn().mockResolvedValue(consultation),
    findConsultationChain: vi.fn().mockResolvedValue([consultation]),
    findByPatientAndDate: vi.fn().mockResolvedValue([consultation]),
  };
  const summaryMetaRepo = { create: vi.fn().mockResolvedValue({ id: 'meta-1' }), encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined) };
  const namedEntityRepo = { findByContextItem: vi.fn().mockResolvedValue([]) };
  const eventEmitter = { emit: vi.fn() };
  const clsService = {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'tenantId') return clsTenantId;
      if (key === 'user') return { id: 'doctor-A', firstName: 'Dr', lastName: 'A' };
      return null;
    }),
    set: vi.fn(),
  };
  const secretsService = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') };
  const agentResolver = { resolve: vi.fn().mockResolvedValue({ slug: 'general-medicine-summarization', task: 'TEXT_GENERATION' }) };
  const agentInvocation = {
    invokeText: vi.fn().mockResolvedValue({ text: 'Result.', provider: 'lm-studio', model: 'resolved-medgemma', usage: null }),
  };

  const service = new ChainSummaryService(
    contextItemRepo as any,
    consultationRepo as any,
    summaryMetaRepo as any,
    namedEntityRepo as any,
    eventEmitter as any,
    clsService as any,
    agentResolver as any,
    agentInvocation as any,
    secretsService as any,
  );

  return { service, agentResolver, agentInvocation };
}

describe('ChainSummaryService — explicit tenant assertion (B-04)', () => {
  it('resolves the tenant`s agent for the finalize phase with the tenant passed explicitly', async () => {
    const { service, agentResolver, agentInvocation } = createService('tenant-1');

    await service.generateComprehensiveSummary('consultation-A', { includeNER: false });

    expect(agentResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', selectorTags: ['phase:finalize'] }));
    expect(agentInvocation.invokeText.mock.calls[0][1]).toBe('tenant-1');
  });

  it('throws BadRequestException (not a silent SYSTEM default) when CLS has no tenant', async () => {
    const { service, agentResolver, agentInvocation } = createService(null);

    await expect(service.generateComprehensiveSummary('consultation-A', { includeNER: false })).rejects.toThrow(BadRequestException);
    await expect(service.generateComprehensiveSummary('consultation-A', { includeNER: false })).rejects.toThrow(/Tenant ID is required/);

    expect(agentResolver.resolve).not.toHaveBeenCalled();
    expect(agentInvocation.invokeText).not.toHaveBeenCalled();
  });
});
