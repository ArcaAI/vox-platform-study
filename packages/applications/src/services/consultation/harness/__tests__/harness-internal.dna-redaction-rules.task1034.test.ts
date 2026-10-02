/**
 * TASK-1034 R3 — the harness gateway lane (`HarnessInternalService.assemble`) hands prompt
 * assembly the doctor's redaction rules as INSTRUCTIONS (`dnaRedactionRulesText`), behind the
 * effective DNA REDACTION gate — never the style gate. Fail-safe: any failure renders no rules
 * (the deterministic post-generation pass stays the guarantee).
 */
import { describe, expect, it, vi } from 'vitest';
import { ConsultationEntity, ConsultationStatus, ResourceStatusType } from '@arcaai/domains';

import { HarnessInternalService } from '../harness-internal.service';

const TENANT = 'tenant-1034';
const CID = 'consultation-1034';

const cls = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((...args: unknown[]) => ((args.length === 1 ? args[0] : args[1]) as () => unknown)()),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
};

const RULES = { rules: [{ id: 'r1', type: 'remove', match: 'literal', pattern: 'Ms. Ada Byron' }] };

function build(opts: { redaction?: boolean | 'throw'; rules?: unknown; repo?: boolean } = {}) {
  const child = new ConsultationEntity({
    id: CID,
    tenantId: TENANT,
    patientId: 'p-1',
    appointmentDate: new Date('2026-10-01T00:00:00.000Z'),
    doctorId: 'doctor-1',
    departmentId: 'dept-1',
    status: ConsultationStatus.RECORDING,
    metadata: null,
    degradedReasons: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'user-1',
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    version: 1,
  } as never);
  const contextItemRepository = {
    findTranscripts: vi.fn().mockResolvedValue([{ id: 'tx-1', content: 'Patient feels better.' }]),
    findCaseNotes: vi.fn().mockResolvedValue([]),
    findWorknotes: vi.fn().mockResolvedValue([]),
    findAttachments: vi.fn().mockResolvedValue([]),
    findPreSummaries: vi.fn().mockResolvedValue([]),
    findByType: vi.fn().mockResolvedValue([]),
    findLatestByKindKey: vi.fn().mockResolvedValue(null),
    findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null, plaintext: null })),
  };
  const promptAssemblyService = {
    assemble: vi
      .fn()
      .mockResolvedValue({
        userPrompt: 'prompt',
        systemPrompt: 'system',
        hyperparameters: {},
        responseFormat: null,
        resolvedFrom: 'department',
        promptId: 'tpl-1',
      }),
  };
  const configResolver = {
    resolveRevisitCarryForwardEnabled: vi.fn(async () => false),
    resolvePreferredPromptTemplateId: vi.fn(async () => null),
    resolveEffectiveDnaStyleEnabled: vi.fn(async () => ({ effective: false, tenantEnabled: false, doctorToggle: null })),
    resolveEffectiveDnaRedactionEnabled: vi.fn(async () => {
      if (opts.redaction === 'throw') throw new Error('graph lookup down');
      return { effective: opts.redaction ?? true, tenantEnabled: true, doctorToggle: null };
    }),
  };
  const dnaReportRepository = {
    findLatestForDoctor: vi.fn(async () => ({ id: 'dna-report-1' })),
    decryptFieldsFromEntity: vi.fn(async () => ({ styleText: 'Terse.', redactionRules: opts.rules === undefined ? RULES : opts.rules })),
  };
  const positional: unknown[] = [
    contextItemRepository,
    { findById: vi.fn(async () => child), update: vi.fn(), updateWithVersion: vi.fn() },
    { findByConsultation: vi.fn().mockResolvedValue([]), findByContextItem: vi.fn().mockResolvedValue([]) },
    { findByContextItem: vi.fn() },
    promptAssemblyService,
    { findById: vi.fn().mockResolvedValue({ id: 'tpl-1', currentVersionNumber: 1 }) },
    { append: vi.fn() },
    cls(),
    undefined, // jobService
    undefined, // highlightRepository
    undefined, // assuranceService
    configResolver,
  ];
  // Pad every optional dependency up to the trailing DNA report repository.
  while (positional.length < 28) positional.push(undefined);
  positional.push(opts.repo === false ? undefined : dnaReportRepository);
  const service = new (HarnessInternalService as unknown as new (...args: unknown[]) => HarnessInternalService)(...positional);
  return { service, promptAssemblyService, dnaReportRepository };
}

const dto = { tenantId: TENANT, userId: 'user-1', conversationLanguage: 'en' } as never;
const paramsOf = (assemble: ReturnType<typeof vi.fn>) => assemble.mock.calls[0][0] as Record<string, unknown>;

describe('TASK-1034 R3 — HarnessInternalService.assemble carries the redaction rules as instructions', () => {
  it('passes the rendered rules when the REDACTION gate is effective — even with the style gate off', async () => {
    const { service, promptAssemblyService } = build();
    await service.assemble(CID, dto);
    expect(paramsOf(promptAssemblyService.assemble).dnaRedactionRulesText).toBe('- Never write "Ms. Ada Byron".');
  });

  it.each([
    ['the redaction gate is off', { redaction: false }],
    ['the gate lookup throws', { redaction: 'throw' as const }],
    ['the doctor authored no rules', { rules: null }],
    ['the rule set is malformed', { rules: { rules: [{ id: 'r1', type: 'delete', match: 'literal', pattern: 'x' }] } }],
    ['the repository is unwired', { repo: false }],
  ])('omits them when %s', async (_label, opts) => {
    const { service, promptAssemblyService } = build(opts);
    await service.assemble(CID, dto);
    expect(paramsOf(promptAssemblyService.assemble)).not.toHaveProperty('dnaRedactionRulesText');
  });
});
