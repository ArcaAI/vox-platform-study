/**
 * ChainSummaryService.callTextService — explicit tenant assertion
 *
 * `resolveTextSelection()` used to be called with NO tenantId, relying on
 * `HarnessPolicyService`'s own CLS fallback — a worker/CLS-less caller could
 * silently be served the SYSTEM default model instead of the tenant's. The
 * call site now resolves `this.tenantId` (BaseService CLS getter) EXPLICITLY
 * and throws `BadRequestException('Tenant ID is required')` when absent,
 * rather than ever reaching `resolveTextSelection()` with an implicit/empty
 * tenant.
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
  const httpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'Result.' } }) } };
  const configService = { get: vi.fn().mockImplementation((key: string) => (key === 'TEXT_URL' ? 'http://text:8862' : null)) };
  const eventEmitter = { emit: vi.fn() };
  const clsService = {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'tenantId') return clsTenantId;
      if (key === 'user') return { id: 'doctor-A', firstName: 'Dr', lastName: 'A' };
      return null;
    }),
    set: vi.fn(),
  };
  const promptAssemblyService = {
    assemble: vi.fn().mockResolvedValue({
      userPrompt: 'assembled prompt text',
      systemPrompt: '',
      hyperparameters: {},
      responseFormat: null,
      resolvedFrom: 'default',
    }),
  };
  const secretsService = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') };
  const harnessPolicyService = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'resolved-medgemma' }) };
  const configResolver = { resolvePreferredPromptTemplateId: vi.fn().mockResolvedValue(null) };

  const service = new ChainSummaryService(
    contextItemRepo as any,
    consultationRepo as any,
    summaryMetaRepo as any,
    namedEntityRepo as any,
    httpService as any,
    configService as any,
    eventEmitter as any,
    clsService as any,
    promptAssemblyService as any,
    secretsService as any,
    harnessPolicyService as any,
    configResolver as any,
  );

  return { service, httpService, harnessPolicyService };
}

describe('ChainSummaryService.callTextService — explicit tenant assertion (B-04)', () => {
  it('resolves the TEXT selection with the CLS tenant + finalize task passed explicitly', async () => {
    const { service, harnessPolicyService } = createService('tenant-1');

    await service.generateComprehensiveSummary('consultation-A', { includeNER: false });

    expect(harnessPolicyService.resolveTextSelection).toHaveBeenCalledWith('tenant-1', 'finalize');
  });

  it('throws BadRequestException (not a silent SYSTEM default) when CLS has no tenant', async () => {
    const { service, harnessPolicyService, httpService } = createService(null);

    await expect(service.generateComprehensiveSummary('consultation-A', { includeNER: false })).rejects.toThrow(BadRequestException);
    await expect(service.generateComprehensiveSummary('consultation-A', { includeNER: false })).rejects.toThrow(/Tenant ID is required/);

    expect(harnessPolicyService.resolveTextSelection).not.toHaveBeenCalled();
    expect(httpService.axiosRef.post).not.toHaveBeenCalled();
  });
});
