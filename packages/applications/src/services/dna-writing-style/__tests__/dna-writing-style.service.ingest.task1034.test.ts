/* TASK-1034 — ingest persistence. Fixture shape copied from the TASK-974 ingest suite. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DnaSampleSource, ResourceStatusType } from '@arcaai/domains';
import { DnaWritingStyleService } from '../dna-writing-style.service';

const TENANT = 'tenant-1';
const CALLER = 'user-id-1';
const CLINICIAN = 'doctor-id-2';

const reportRepo = { findLatestForDoctor: vi.fn(), findAll: vi.fn(), create: vi.fn(), update: vi.fn() };
const versionRepo = { create: vi.fn() };
const usageRepo = { create: vi.fn(), findAll: vi.fn() };
const userRoleAssignmentRepo = { findFirst: vi.fn(), findAll: vi.fn() };
const userDepartmentRepo = { findFirst: vi.fn() };
const userRepo = { findFirst: vi.fn() };
const queue = { add: vi.fn(), getJob: vi.fn() };
const eventEmitter = { emit: vi.fn() };
const databaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const memoryStore = { store: vi.fn() };
const configResolver = { resolveEffectiveDnaStyleEnabled: vi.fn() };

const clsStore: Record<string, unknown> = {};
const cls = {
  get: vi.fn((key: string) => clsStore[key]),
  set: vi.fn((key: string, value: unknown) => {
    clsStore[key] = value;
  }),
};

function make(): DnaWritingStyleService {
  return new DnaWritingStyleService(
    reportRepo as never,
    versionRepo as never,
    usageRepo as never,
    userRoleAssignmentRepo as never,
    userDepartmentRepo as never,
    userRepo as never,
    queue as never,
    eventEmitter as never,
    cls as never,
    databaseService as never,
    configResolver as never,
    undefined, // secretsService
    undefined, // userSettingsRepository
    undefined, // entitlements
    undefined, // billing
    undefined, // usageLedgerService
    memoryStore as never,
  );
}

const items = [
  { text: 'Follow-up note.', writtenAt: '2026-09-02T09:00:00.000Z', kind: 'CASE_NOTE' as const },
  { text: 'Initial note.', writtenAt: '2026-09-01T09:00:00.000Z' },
];

const jwt = (principalId = CALLER) => ({ credentialClass: 'jwt' as const, principalId });

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(clsStore)) delete clsStore[key];
  clsStore.tenantId = TENANT;
  clsStore.user = { id: CALLER, roles: ['DOCTOR'] };
  userRoleAssignmentRepo.findFirst.mockResolvedValue({ id: 'ura', userId: CLINICIAN, tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED });
  // The BOUND human behind a machine credential holds no role by default — the fail-closed side.
  userRoleAssignmentRepo.findAll.mockResolvedValue([]);
  // No job exists under a derived id until one is added — the idempotency JOIN is opt-in per test.
  queue.getJob.mockResolvedValue(null);
  memoryStore.store.mockImplementation(async (input: { text: string }) =>
    input.text === 'Initial note.' ? { stored: false, duplicateOf: 'old' } : { stored: true, id: 'new' },
  );
  userDepartmentRepo.findFirst.mockResolvedValue({ id: 'ud', userId: CLINICIAN, tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED });
  userRepo.findFirst.mockResolvedValue({ id: CLINICIAN, isServiceAccount: false });
  configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({
    effective: true,
    tenantEnabled: true,
    doctorToggle: null,
    doctorPreferenceVersion: 0,
  });
});


/**
 * TASK-1034 §4b — ingest now PERSISTS every item as DNA memory (source INGEST, encrypted,
 * deduped), and `generate: false` loads history without queuing an analysis.
 */
describe('ingest persists memory (TASK-1034)', () => {
  it('stores each item as an INGEST sample and reports stored / duplicates', async () => {
    const result = await make().ingestWritingSamples({ items }, jwt());

    expect(memoryStore.store).toHaveBeenCalledTimes(2);
    const first = memoryStore.store.mock.calls[0]![0] as Record<string, unknown>;
    expect(first).toMatchObject({ tenantId: TENANT, doctorId: CALLER, source: DnaSampleSource.INGEST, kind: 'CASE_NOTE' });
    expect(first.writtenAt).toEqual(new Date('2026-09-02T09:00:00.000Z'));
    expect(first.ingestBatchId).toEqual(expect.any(String));
    expect(result).toMatchObject({ stored: 1, duplicates: 1, status: 'PENDING' });
    // generate defaults to true — today's immediate job is unchanged.
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('generate=false stores the history and queues nothing', async () => {
    const result = await make().ingestWritingSamples({ items, generate: false }, jwt());

    expect(queue.add).not.toHaveBeenCalled();
    expect(memoryStore.store).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ jobId: null, status: 'STORED', stored: 1, duplicates: 1, acceptedItems: 2, clinicianUserId: CALLER });
  });

  it('a clinician of ANOTHER tenant is 404 and nothing is stored', async () => {
    clsStore.user = { id: CALLER, roles: ['TENANT_ADMIN'] };
    userRoleAssignmentRepo.findFirst.mockResolvedValue(null);
    userDepartmentRepo.findFirst.mockResolvedValue(null);
    userRepo.findFirst.mockResolvedValue(null);

    await expect(make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items, generate: false }, jwt())).rejects.toBeInstanceOf(NotFoundException);
    expect(memoryStore.store).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('an opted-out clinician stores nothing (409)', async () => {
    configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: false });
    await expect(make().ingestWritingSamples({ items, generate: false }, jwt())).rejects.toBeInstanceOf(ConflictException);
    expect(memoryStore.store).not.toHaveBeenCalled();
  });
});
