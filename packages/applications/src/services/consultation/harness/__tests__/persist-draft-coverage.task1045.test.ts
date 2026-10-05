/**
 * TASK-1045 lane E6 (H-110) — `persistDraft` records a NotePlan's coverage.
 *
 *  - `coverage` (CoverageResultV1, camelCase) is accepted by the DTO;
 *  - SummaryMeta carries `coverageStatus`, `coverageGapCount` and the report, which is encrypted on
 *    write (Transit, via the repository's `encryptFieldsIntoEntity`) — never stored as plaintext;
 *  - `gaps` → processing AWAITING_REVIEW with the gap count; `complete` / `unchecked` → IDLE;
 *  - the response carries the note's `versionNumber`;
 *  - a harness-doc run that FAILED (the executor raised, so nothing was persisted) moves a STOPPED
 *    consultation with no note to FAILED with the reason.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ContextItemType, ResourceStatusType } from '@arcaai/domains';

import { HarnessInternalService } from '../harness-internal.service';
import { HARNESS_DRAFT_PHASE, HARNESS_PROGRESS_FAILED_STAGE, HarnessDraftRequest } from '../dto';
import fixture from '../../../../../../../tests/contracts/note-plan.fixture.json';
import { NOTE_READY_REASON } from '../../lifecycle/legacy-status-projection';

const TENANT = '50000000-0000-0000-0000-000000000045';
const CID = '0199a000-0000-7000-8000-0000000000c1';

const coverage = (name: string) => structuredClone(fixture.coverageResults.find((entry) => entry.name === name)!.result) as Record<string, unknown>;

const createMockCls = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((...args: unknown[]) => ((args.length === 1 ? args[0] : args[1]) as () => unknown)()),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
};

function consultation(overrides: Record<string, unknown> = {}): ConsultationEntity {
  return new ConsultationEntity({
    id: CID,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-10-05'),
    metadata: null,
    degradedReasons: [],
    status: ConsultationStatus.STOPPED,
    processing: ConsultationProcessing.SUMMARIZING,
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-10-05'),
    updatedAt: new Date('2026-10-05'),
    createdBy: 'user-1',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    version: 7,
    ...overrides,
  } as never);
}

function build(options: { consultation?: ConsultationEntity; ownDrafts?: Array<Record<string, unknown>>; existingMeta?: Record<string, unknown> | null } = {}) {
  const row = options.consultation ?? consultation();
  const contextItemRepository = {
    findTranscripts: vi.fn().mockResolvedValue([]),
    findByType: vi.fn(async (_cid: string, type: ContextItemType) => (type === ContextItemType.RAW_SUMMARY ? (options.ownDrafts ?? []) : [])),
    findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null, plaintext: null })),
    findById: vi.fn(async (id: string) => ({ id, content: 'note' })),
    create: vi.fn(async (entity: Record<string, unknown>) => ({ ...entity, id: 'ctx-new' })),
    update: vi.fn(),
    updateWithVersion: vi.fn(async (id: string, entity: Record<string, unknown>) => ({ ...entity, id })),
    encryptContentIntoEntity: vi.fn(),
  };
  const summaryMetaRepository = {
    findByContextItem: vi.fn(async () => options.existingMeta ?? null),
    updateWithVersion: vi.fn(async () => ({ id: 'sm-1' })),
    encryptFieldsIntoEntity: vi.fn(),
    create: vi.fn(async () => ({ id: 'sm-new' })),
  };
  const lifecycleGate = {
    assertContentWritable: vi.fn(),
    setProcessing: vi.fn().mockResolvedValue(undefined),
  };
  const progressService = { reportProgress: vi.fn().mockResolvedValue({ ok: true }) };
  const secretsService = { encrypt: vi.fn(), decrypt: vi.fn() };
  const positional: unknown[] = [
    contextItemRepository,
    { findById: vi.fn(async () => row) },
    { findByConsultation: vi.fn().mockResolvedValue([]), findByContextItem: vi.fn().mockResolvedValue([]) },
    summaryMetaRepository,
    { assemble: vi.fn() },
    { findById: vi.fn() },
    { append: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    createMockCls(),
    undefined, // jobService
    undefined, // highlightRepository
    undefined, // assuranceService
    undefined, // configResolver
    undefined, // contextItemVersionRepository
    secretsService, // 14
    undefined, // redisCache
    undefined, // transcriptSegmentRepository
    undefined, // harnessPolicyService
    undefined, // mcpServerRepository
    undefined, // usageLedgerService
    undefined, // notificationService
    undefined, // providerConnectionService
    undefined, // visitTypes
    undefined, // aiModelRepository
    progressService, // 24
    { emit: vi.fn() }, // 25 eventEmitter
    undefined, // routingPolicies
    undefined, // effectiveSettings
    undefined, // dnaReportRepository
    lifecycleGate, // 29
  ];
  const service = new (HarnessInternalService as unknown as new (...args: unknown[]) => HarnessInternalService)(...positional);
  return { service, row, contextItemRepository, summaryMetaRepository, lifecycleGate, progressService };
}

const draft = (extra: Record<string, unknown> = {}) =>
  ({ tenantId: TENANT, userId: 'harness', content: '## Subjective\nCough.', modelName: 'm', modelVersion: 'v', ...extra }) as never;

/** The SummaryMeta entity handed to `create` (a new note). */
const createdMeta = (repo: ReturnType<typeof build>['summaryMetaRepository']) => repo.create.mock.calls[0]![0] as Record<string, unknown>;

describe('TASK-1045 E6 — HarnessDraftRequest accepts coverage', () => {
  it('validates a CoverageResultV1 under the strict pipe options', async () => {
    const instance = plainToInstance(HarnessDraftRequest, { tenantId: TENANT, content: 'x', coverage: coverage('gaps_after_repair') });
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
    expect(errors).toEqual([]);
  });

  it('refuses a coverage that is not an object', async () => {
    const instance = plainToInstance(HarnessDraftRequest, { tenantId: TENANT, content: 'x', coverage: 'complete' });
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((error) => error.property)).toContain('coverage');
  });
});

describe('TASK-1045 E6 — persistDraft records coverage on SummaryMeta', () => {
  it('complete: status + zero gaps, the report encrypted on write, processing IDLE, versionNumber 1', async () => {
    const { service, summaryMetaRepository, lifecycleGate } = build();
    const report = coverage('complete');

    const result = await service.persistDraft(CID, draft({ coverage: report }));

    const meta = createdMeta(summaryMetaRepository);
    expect(meta.coverageStatus).toBe('complete');
    expect(meta.coverageGapCount).toBe(0);
    expect(meta.coverageReport).toEqual(report);
    // Encrypt-on-write ran over the very entity that is created (the sidecar moves the report into
    // `encryptedCoverageReport`), and before the insert.
    expect(summaryMetaRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(meta, expect.anything());
    expect(summaryMetaRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0]).toBeLessThan(summaryMetaRepository.create.mock.invocationCallOrder[0]!);
    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.IDLE, NOTE_READY_REASON);
    expect(result).toEqual({ contextItemId: 'ctx-new', versionNumber: 1 });
  });

  it('gaps: AWAITING_REVIEW with the gap count, never IDLE', async () => {
    const { service, summaryMetaRepository, lifecycleGate } = build();

    await service.persistDraft(CID, draft({ coverage: coverage('gaps_after_repair') }));

    const meta = createdMeta(summaryMetaRepository);
    expect(meta.coverageStatus).toBe('gaps');
    expect(meta.coverageGapCount).toBe(1);
    expect(lifecycleGate.setProcessing).toHaveBeenCalledTimes(1);
    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.AWAITING_REVIEW, 'NOTE_COVERAGE_GAPS:1');
  });

  it('gaps on an EARLY draft also wait for review (assurance still gates sign-off)', async () => {
    const { service, lifecycleGate } = build();

    await service.persistDraft(CID, draft({ coverage: coverage('gaps_after_repair'), phase: HARNESS_DRAFT_PHASE.EARLY }));

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.AWAITING_REVIEW, 'NOTE_COVERAGE_GAPS:1');
  });

  it('unchecked: recorded as unchecked with its gap, processing IDLE (an unchecked note is not a gap)', async () => {
    const { service, summaryMetaRepository, lifecycleGate } = build();

    await service.persistDraft(CID, draft({ coverage: coverage('unchecked_ledger_unavailable') }));

    const meta = createdMeta(summaryMetaRepository);
    expect(meta.coverageStatus).toBe('unchecked');
    expect(meta.coverageGapCount).toBe(1);
    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.IDLE, NOTE_READY_REASON);
  });

  it('no coverage (a run without a plan): the coverage columns stay null and nothing else changes', async () => {
    const { service, summaryMetaRepository, lifecycleGate } = build();

    await service.persistDraft(CID, draft());

    const meta = createdMeta(summaryMetaRepository);
    expect(meta.coverageStatus).toBeNull();
    expect(meta.coverageGapCount).toBeNull();
    expect(meta.coverageReport).toBeNull();
    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.IDLE, NOTE_READY_REASON);
  });

  it('a malformed coverage never costs the note: it is persisted with no coverage recorded', async () => {
    const { service, summaryMetaRepository, lifecycleGate } = build();

    const result = await service.persistDraft(CID, draft({ coverage: { status: 'gaps', gaps: 'nope' } }));

    expect(result.contextItemId).toBe('ctx-new');
    expect(createdMeta(summaryMetaRepository).coverageStatus).toBeNull();
    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.IDLE, NOTE_READY_REASON);
  });

  it('an adopted draft re-stamps coverage on the existing meta and returns the new version number', async () => {
    const existingMeta: Record<string, unknown> = { id: 'sm-1', version: 3, citationsMap: null };
    const { service, summaryMetaRepository } = build({
      ownDrafts: [{ id: 'ctx-draft', content: 'old note', currentVersionNumber: 2, version: 5, metaData: { subType: 'HARNESS_DRAFT' }, createdAt: new Date() }],
      existingMeta,
    });

    const result = await service.persistDraft(CID, draft({ coverage: coverage('gaps_after_repair') }));

    expect(existingMeta.coverageStatus).toBe('gaps');
    expect(existingMeta.coverageGapCount).toBe(1);
    expect(existingMeta.coverageReport).toEqual(coverage('gaps_after_repair'));
    expect(summaryMetaRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(existingMeta, expect.anything());
    expect(result).toEqual({ contextItemId: 'ctx-draft', versionNumber: 3 });
  });
});

describe('TASK-1045 E6 — a failed harness-doc run fails the consultation', () => {
  const failed = { tenantId: TENANT, stage: HARNESS_PROGRESS_FAILED_STAGE, jobId: 'harness-doc-1' } as never;

  it('a STOPPED consultation with no note goes FAILED with the reason', async () => {
    const { service, lifecycleGate } = build();

    await service.reportProgress(CID, failed);

    expect(lifecycleGate.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.FAILED, 'NOTE_GENERATION_FAILED');
  });

  it('leaves a consultation whose note is already written alone', async () => {
    const { service, lifecycleGate } = build({
      consultation: consultation({ processing: ConsultationProcessing.IDLE }),
      ownDrafts: [{ id: 'ctx-draft', metaData: { subType: 'HARNESS_DRAFT' }, createdAt: new Date() }],
    });

    await service.reportProgress(CID, failed);

    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
  });

  it('an ordinary stage changes nothing', async () => {
    const { service, lifecycleGate } = build();

    await service.reportProgress(CID, { tenantId: TENANT, stage: 'drafting_note' } as never);

    expect(lifecycleGate.setProcessing).not.toHaveBeenCalled();
  });
});
