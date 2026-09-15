/**
 * TASK-974 §9.2 (design D-5) — the DNA plane is pre-checked before it spends, and an
 * accepted ingest is recorded.
 *
 * ============================================================================
 * WHY A PRE-CHECK AND NOT A POST-HOC DEBIT
 * ============================================================================
 * The meter is post-hoc by design (D6): this call's token count is unknowable until TEXT
 * answers, so `assertMeterQuota` compares month-to-date rollups against the allowance rather
 * than predicting the call. What it CAN do is refuse to start one more expensive job for a
 * tenant that is already over — which is why it runs before `queue.add` and not inside the
 * processor, where a 429 would surface as a failed job hours later. `assertSpendLimit` answers
 * the question a meter cannot: a meter caps a QUANTITY of one unit, the ceiling caps MONEY.
 *
 * Both are OUTSIDE any try/catch: a quota refusal disguised as a queued job is the failure this
 * ordering exists to prevent.
 *
 * `dna.ingest` itself is the one row on this plane that is not an inference call landing. It
 * records what a caller SUBMITTED — the only measure of the ingest surface that exists before
 * the job runs — and it is fire-and-forget, because a metering problem must never turn an
 * accepted 202 into a failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceStatusType } from '@arcaai/domains';
import { DnaWritingStyleService } from '../dna-writing-style.service';
import { DnaRegenerationScheduler } from '../dna-regeneration.scheduler';
import type { UsageEventBatchInput } from '../../usageLedger/dto';

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
const configResolver = { resolveEffectiveDnaStyleEnabled: vi.fn() };

const entitlements = { assertMeterQuota: vi.fn() };
const billing = { assertSpendLimit: vi.fn() };
const usageLedger = { recordUsage: vi.fn() };

const clsStore: Record<string, unknown> = {};
const cls = {
  get: vi.fn((key: string) => clsStore[key]),
  set: vi.fn((key: string, value: unknown) => {
    clsStore[key] = value;
  }),
};

function make(options: { metered?: boolean } = {}): DnaWritingStyleService {
  const { metered = true } = options;
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
    // ─── TASK-974 §9.2 — the billing seam, `@Optional()` and TRAILING ────────────────
    metered ? (entitlements as never) : undefined,
    metered ? (billing as never) : undefined,
    metered ? (usageLedger as never) : undefined,
  );
}

const items = [
  { text: 'Follow-up note.', writtenAt: '2026-09-02T09:00:00.000Z', kind: 'CASE_NOTE' as const },
  { text: 'Initial note, longer.', writtenAt: '2026-09-01T09:00:00.000Z' },
];

const jwt = (principalId = CALLER) => ({ credentialClass: 'jwt' as const, principalId });
const serviceAccount = { credentialClass: 'service-account' as const, principalId: 'svc-1' };

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(clsStore)) delete clsStore[key];
  clsStore.tenantId = TENANT;
  clsStore.user = { id: CALLER, roles: ['DOCTOR'] };
  userRoleAssignmentRepo.findFirst.mockResolvedValue({ id: 'ura', userId: CLINICIAN, tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED });
  userRoleAssignmentRepo.findAll.mockResolvedValue([]);
  queue.getJob.mockResolvedValue(null);
  queue.add.mockResolvedValue({ id: 'job' });
  userDepartmentRepo.findFirst.mockResolvedValue({ id: 'ud', userId: CLINICIAN, tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED });
  userRepo.findFirst.mockResolvedValue({ id: CLINICIAN, isServiceAccount: false });
  configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: true, tenantEnabled: true, doctorToggle: null, doctorPreferenceVersion: 0 });
  entitlements.assertMeterQuota.mockResolvedValue(undefined);
  billing.assertSpendLimit.mockResolvedValue(undefined);
  usageLedger.recordUsage.mockResolvedValue({ outboxIds: ['o1'], events: 3 });
});

const ingestBatch = (): UsageEventBatchInput => usageLedger.recordUsage.mock.calls[0]![0] as UsageEventBatchInput;
const quantityOf = (batch: UsageEventBatchInput, unit: string) => batch.units.find((u) => u.unit === unit)?.quantity;
/** Let the fire-and-forget emission settle before asserting on it. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('generateDnaReport pre-checks the allowance before it queues', () => {
  it('asserts the LLM meter and the spend ceiling, then enqueues', async () => {
    await make().generateDnaReport(CLINICIAN, {} as never);

    expect(entitlements.assertMeterQuota).toHaveBeenCalledWith(TENANT, 'monthlyLlmTokens');
    expect(billing.assertSpendLimit).toHaveBeenCalledWith(TENANT);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('queues NOTHING when the tenant is over its LLM allowance', async () => {
    // A 429 hours later, as a failed job, is not the same product as a 429 now.
    entitlements.assertMeterQuota.mockRejectedValue(Object.assign(new Error('quota'), { status: 429 }));

    await expect(make().generateDnaReport(CLINICIAN, {} as never)).rejects.toThrow('quota');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('queues NOTHING when the tenant has reached its monthly spend ceiling', async () => {
    billing.assertSpendLimit.mockRejectedValue(Object.assign(new Error('spend limit'), { status: 402 }));

    await expect(make().generateDnaReport(CLINICIAN, {} as never)).rejects.toThrow('spend limit');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('is a no-op when neither service is composed — enforcement is opt-in, not a precondition', async () => {
    await expect(make({ metered: false }).generateDnaReport(CLINICIAN, {} as never)).resolves.toMatchObject({ status: 'PENDING' });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('ingestWritingSamples pre-checks the same two gates', () => {
  it('asserts both BEFORE the enqueue', async () => {
    await make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items } as never, serviceAccount);

    expect(entitlements.assertMeterQuota).toHaveBeenCalledWith(TENANT, 'monthlyLlmTokens');
    expect(billing.assertSpendLimit).toHaveBeenCalledWith(TENANT);
    expect(entitlements.assertMeterQuota.mock.invocationCallOrder[0]).toBeLessThan(queue.add.mock.invocationCallOrder[0]!);
    expect(billing.assertSpendLimit.mock.invocationCallOrder[0]).toBeLessThan(queue.add.mock.invocationCallOrder[0]!);
  });

  it('refuses an over-allowance tenant without queuing or metering anything', async () => {
    entitlements.assertMeterQuota.mockRejectedValue(Object.assign(new Error('quota'), { status: 429 }));

    await expect(make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items } as never, serviceAccount)).rejects.toThrow('quota');
    await settle();
    expect(queue.add).not.toHaveBeenCalled();
    expect(usageLedger.recordUsage).not.toHaveBeenCalled();
  });
});

describe('an accepted ingest is recorded as `dna.ingest`', () => {
  it('records REQUEST, CHARACTER and INGRESS_BYTE for the batch that was submitted', async () => {
    const dto = { clinicianUserId: CLINICIAN, items };

    await make().ingestWritingSamples(dto as never, serviceAccount);
    await settle();

    const batch = ingestBatch();
    expect(batch.common.operation).toBe('dna.ingest');
    expect(batch.common.capability).toBe('LLM');
    // The gateway accepted it; no vendor ran a model.
    expect(batch.common.provider).toBe('hope-api');
    expect(batch.common.model ?? null).toBeNull();
    expect(batch.common.deployment).toBe('SELF_HOSTED');
    expect(batch.common.costBasis).toBe('INTERNAL');

    expect(quantityOf(batch, 'REQUEST')).toBe(1);
    expect(quantityOf(batch, 'CHARACTER')).toBe(items[0]!.text.length + items[1]!.text.length);
    expect(quantityOf(batch, 'INGRESS_BYTE')).toBe(Buffer.byteLength(JSON.stringify(dto)));
  });

  it('attributes the row to the CLINICIAN and the job, and names the credential class', async () => {
    await make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items } as never, serviceAccount);
    await settle();

    const batch = ingestBatch();
    // The clinician the profile is ABOUT — never the machine that submitted for them.
    expect(batch.common.doctorId).toBe(CLINICIAN);
    const jobId = (queue.add.mock.calls[0]![1] as { jobId: string }).jobId;
    expect(batch.common.requestId).toBe(jobId);
    expect(batch.common.idempotencyKey).toBe(`dna-ingest:${jobId}`);
    expect(batch.common.attributesJson).toMatchObject({ credentialClass: 'service-account', origin: 'ingest' });
  });

  it('names the human`s class when a clinician ingests for themselves', async () => {
    await make().ingestWritingSamples({ items } as never, jwt());
    await settle();

    expect(ingestBatch().common.attributesJson).toMatchObject({ credentialClass: 'jwt' });
  });

  it('emits NOTHING when a retry JOINS an existing job — one submitted batch, one row', async () => {
    queue.getJob.mockResolvedValue({
      data: { jobId: 'joined-1', doctorId: CLINICIAN, tenantId: TENANT, userId: CLINICIAN, samples: [{ text: 'x', writtenAt: '2026-09-01T09:00:00.000Z', kind: 'OTHER' }] },
    });

    const joined = await make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items } as never, serviceAccount, 'batch-42');
    await settle();

    // It really joined: the 202 answers the ORIGINAL enqueue's window and item count, not
    // this retry's two items.
    expect(joined.acceptedItems).toBe(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(usageLedger.recordUsage).not.toHaveBeenCalled();
  });

  it('never fails the 202 when the ledger is down', async () => {
    usageLedger.recordUsage.mockRejectedValue(new Error('outbox unavailable'));

    await expect(make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items } as never, serviceAccount)).resolves.toMatchObject({
      status: 'PENDING',
      acceptedItems: 2,
    });
    await settle();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('records nothing when no ledger is composed', async () => {
    await expect(make({ metered: false }).ingestWritingSamples({ clinicianUserId: CLINICIAN, items } as never, serviceAccount)).resolves.toMatchObject({
      status: 'PENDING',
    });
    await settle();
    expect(usageLedger.recordUsage).not.toHaveBeenCalled();
  });
});

describe('the monthly sweep skips a tenant that cannot pay for it', () => {
  const REPORTS = [
    { doctorId: 'doctor-a', tenantId: 'tenant-a', isLatest: true, resourceStatus: ResourceStatusType.ENABLED },
    { doctorId: 'doctor-b', tenantId: 'tenant-b', isLatest: true, resourceStatus: ResourceStatusType.ENABLED },
  ];

  function scheduler() {
    const dnaReportRepository = {
      $: vi.fn(() => ({ Where: vi.fn(), ToList: vi.fn().mockResolvedValue(REPORTS) })),
    };
    return new DnaRegenerationScheduler(
      { getValueWithDefault: vi.fn(<T>(_key: string, fallback: T): T => fallback) } as never,
      { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as never,
      dnaReportRepository as never,
      queue as never,
      entitlements as never,
      billing as never,
    );
  }

  it('checks each tenant ONCE and queues every doctor when both gates pass', async () => {
    const result = await scheduler().regenerateAllDoctors();

    expect(result.jobsQueued).toBe(2);
    expect(entitlements.assertMeterQuota).toHaveBeenCalledTimes(2);
    expect(entitlements.assertMeterQuota).toHaveBeenCalledWith('tenant-a', 'monthlyLlmTokens');
    expect(billing.assertSpendLimit).toHaveBeenCalledWith('tenant-b');
  });

  it('SKIPS the tenant that is over and finishes the sweep for everybody else', async () => {
    // A monthly rebuild nobody asked for must not spend an allowance a tenant needs for
    // clinical work — and one tenant's ceiling must not stop the sweep.
    entitlements.assertMeterQuota.mockImplementation(async (tenantId: string) => {
      if (tenantId === 'tenant-a') throw Object.assign(new Error('quota'), { status: 429 });
    });

    const result = await scheduler().regenerateAllDoctors();

    expect(result.jobsQueued).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('tenant-a');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect((queue.add.mock.calls[0]![1] as { tenantId: string }).tenantId).toBe('tenant-b');
  });

  it('sweeps unchanged when neither service is composed', async () => {
    const dnaReportRepository = { $: vi.fn(() => ({ Where: vi.fn(), ToList: vi.fn().mockResolvedValue(REPORTS) })) };
    const bare = new DnaRegenerationScheduler(
      { getValueWithDefault: vi.fn(<T>(_key: string, fallback: T): T => fallback) } as never,
      { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as never,
      dnaReportRepository as never,
      queue as never,
    );

    await expect(bare.regenerateAllDoctors()).resolves.toMatchObject({ jobsQueued: 2, errors: [] });
  });
});
