/**
 * TASK-974 §5.1 item 7 — `ingestWritingSamples`.
 *
 * The clinician-resolution rules are the whole of this surface's authorization, and none of them
 * is expressible in a decorator:
 *
 *  · a MACHINE is never itself the clinician, so it must NAME one (400);
 *  · a HUMAN omitting the name gets themselves, but only if they are acting as a clinician —
 *    the same rule `generate` applies, for the same reason: an admin would otherwise build a
 *    writing-style profile under their own account;
 *  · a human NAMING someone else is doing an administrative act, so it takes an admin role;
 *  · whoever is named must belong to the caller's tenant, and a cross-tenant id is 404, never
 *    403 — a DNA profile is PHI-derived and its existence is not something to confirm.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JobQueue, ResourceStatusType, SysEventType } from '@arcaai/domains';
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
  );
}

const items = [
  { text: 'Follow-up note.', writtenAt: '2026-09-02T09:00:00.000Z', kind: 'CASE_NOTE' as const },
  { text: 'Initial note.', writtenAt: '2026-09-01T09:00:00.000Z' },
];

const jwt = (principalId = CALLER) => ({ credentialClass: 'jwt' as const, principalId });
const apiKey = (boundUserId: string | null = CALLER) => ({ credentialClass: 'api-key' as const, principalId: 'key-1', boundUserId });
const serviceAccount = { credentialClass: 'service-account' as const, principalId: 'svc-1' };

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
  userDepartmentRepo.findFirst.mockResolvedValue({ id: 'ud', userId: CLINICIAN, tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED });
  userRepo.findFirst.mockResolvedValue({ id: CLINICIAN, isServiceAccount: false });
  configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({
    effective: true,
    tenantEnabled: true,
    doctorToggle: null,
    doctorPreferenceVersion: 0,
  });
});

const payload = () => queue.add.mock.calls[0]![1] as Record<string, unknown>;

/**
 * The CODE of a refusal, not its prose. Every refusal here carries a machine-readable `code` in
 * the response body precisely so an integrator can branch on it; asserting the sentence instead
 * would pin the wording and miss the contract.
 */
async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const response = (error as { getResponse?: () => unknown }).getResponse?.();
    return (response as { code?: string } | undefined)?.code ?? '<no code>';
  }
  return '<did not throw>';
}

describe('who the samples belong to', () => {
  it('a clinician ingesting their OWN samples names nobody, and gets themselves', async () => {
    const result = await make().ingestWritingSamples({ items }, jwt());

    expect(result.clinicianUserId).toBe(CALLER);
    expect(payload().doctorId).toBe(CALLER);
  });

  it('an admin not acting as a clinician cannot ingest under their own account', async () => {
    clsStore.user = { id: CALLER, roles: ['TENANT_ADMIN'] };
    await expect(make().ingestWritingSamples({ items }, jwt())).rejects.toBeInstanceOf(ForbiddenException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a tenant admin MAY name a clinician of their tenant', async () => {
    clsStore.user = { id: CALLER, roles: ['TENANT_ADMIN'] };

    const result = await make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, jwt());

    expect(result.clinicianUserId).toBe(CLINICIAN);
    expect(payload().doctorId).toBe(CLINICIAN);
  });

  it('a clinician may NOT name another clinician — 400, and it says which rule refused', async () => {
    expect(await refusalCode(() => make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, jwt()))).toBe(
      'DNA_INGEST_CLINICIAN_NOT_ALLOWED',
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a MACHINE caller must name a clinician — it is never one itself', async () => {
    clsStore.user = undefined;
    expect(await refusalCode(() => make().ingestWritingSamples({ items }, serviceAccount))).toBe('DNA_INGEST_CLINICIAN_REQUIRED');
    expect(await refusalCode(() => make().ingestWritingSamples({ items }, apiKey()))).toBe('DNA_INGEST_CLINICIAN_REQUIRED');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a machine caller that names one is accepted, and the CLINICIAN owns the profile', async () => {
    clsStore.user = undefined;

    const result = await make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, serviceAccount);

    expect(result.clinicianUserId).toBe(CLINICIAN);
    // The machine is the ACTOR, never the subject: `userId` (which becomes `createdBy` on the
    // report) is the clinician, and the credential is recorded beside them as `requestedBy`.
    expect(payload()).toMatchObject({
      doctorId: CLINICIAN,
      userId: CLINICIAN,
      requestedBy: { credentialClass: 'service-account', principalId: 'svc-1' },
    });
  });

  it('a clinician of ANOTHER tenant is 404 — never 403, and never a confirmation that they exist', async () => {
    clsStore.user = { id: CALLER, roles: ['TENANT_ADMIN'] };
    userRoleAssignmentRepo.findFirst.mockResolvedValue(null);
    userDepartmentRepo.findFirst.mockResolvedValue(null);
    userRepo.findFirst.mockResolvedValue(null);

    await expect(make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, jwt())).rejects.toBeInstanceOf(NotFoundException);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('the batch itself', () => {
  it('enqueues the samples as a time series, defaulting the kind, with origin `ingest`', async () => {
    await make().ingestWritingSamples({ items }, jwt());

    expect(queue.add).toHaveBeenCalledWith(JobQueue.GenerateDnaReport, expect.anything(), expect.objectContaining({ jobId: expect.any(String) }));
    expect(payload()).toMatchObject({
      tenantId: TENANT,
      origin: 'ingest',
      samples: [
        { text: 'Follow-up note.', writtenAt: '2026-09-02T09:00:00.000Z', kind: 'CASE_NOTE' },
        { text: 'Initial note.', writtenAt: '2026-09-01T09:00:00.000Z', kind: 'OTHER' },
      ],
    });
    // The legacy field stays absent: the two carry different things and must not be conflated.
    expect(payload().textSamples).toBeUndefined();
  });

  it('answers 202-shaped with the resolved window, whatever order the caller sent', async () => {
    const result = await make().ingestWritingSamples({ items }, jwt());

    expect(result).toEqual({
      jobId: expect.any(String),
      status: 'PENDING',
      clinicianUserId: CALLER,
      acceptedItems: 2,
      window: { from: '2026-09-01T09:00:00.000Z', to: '2026-09-02T09:00:00.000Z' },
    });
  });

  it('refuses a batch over the total character budget — a cross-field rule no decorator can see', async () => {
    const big = Array.from({ length: 30 }, (_, index) => ({
      text: 'x'.repeat(20_000),
      writtenAt: `2026-09-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
    }));

    expect(await refusalCode(() => make().ingestWritingSamples({ items: big }, jwt()))).toBe('DNA_INGEST_TOO_LARGE');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('audits the REQUEST, naming the credential class that made it', async () => {
    await make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, apiKey(CLINICIAN));

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceCreated,
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'dna-ingest-requested', origin: 'ingest', itemCount: 2, credentialClass: 'api-key' }),
      }),
    );
  });

  it('never audits the samples themselves', async () => {
    await make().ingestWritingSamples({ items: [{ text: 'PATIENT NAME HERE', writtenAt: '2026-09-01T09:00:00.000Z', sourceRef: 'emr://1' }] }, jwt());

    const audited = JSON.stringify(eventEmitter.emit.mock.calls);
    expect(audited).not.toContain('PATIENT NAME HERE');
    expect(audited).not.toContain('emr://1');
  });
});

describe('the DNA gate is checked at ENQUEUE, not only in the worker', () => {
  it('409 DNA_STYLE_DISABLED when the effective flag is off — a caller learns immediately, not by polling a failed job', async () => {
    configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({
      effective: false,
      tenantEnabled: false,
      doctorToggle: null,
      doctorPreferenceVersion: 0,
    });

    await expect(make().ingestWritingSamples({ items }, jwt())).rejects.toBeInstanceOf(ConflictException);
    expect(await refusalCode(() => make().ingestWritingSamples({ items }, jwt()))).toBe('DNA_STYLE_DISABLED');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('requires a tenant context', async () => {
    clsStore.tenantId = undefined;
    await expect(make().ingestWritingSamples({ items }, jwt())).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * L5/F1 — "scopes bind the CREDENTIAL, abilities bind the BOUND HUMAN; they compose as AND, and a
 * credential can never exceed its human" (rule 05 §API Test Standard).
 *
 * The first cut of this surface returned a machine's named `clinicianUserId` unchecked, so an API
 * key minted for one clinician could build — and then read back — a writing-style profile for any
 * other clinician of the tenant. The scope gate could not catch it: `dna-writing-style:ingest` is
 * the scope the key legitimately holds.
 *
 * A SERVICE ACCOUNT is deliberately NOT narrowed the same way (TASK-933): it is the platform's
 * machine identity, bound to a WORKING TENANT rather than to a person, and "any clinician of its
 * tenant" is exactly its remit.
 */
describe('an API key never exceeds the human it is bound to', () => {
  it('may name the clinician it is BOUND to', async () => {
    const result = await make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, apiKey(CLINICIAN));

    expect(result.clinicianUserId).toBe(CLINICIAN);
    expect(userRoleAssignmentRepo.findAll).not.toHaveBeenCalled(); // the cheap answer first
  });

  it('may NOT name a DIFFERENT clinician of the same tenant — 400, the same code a clinician gets', async () => {
    expect(await refusalCode(() => make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, apiKey('someone-else')))).toBe(
      'DNA_INGEST_CLINICIAN_NOT_ALLOWED',
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('MAY name any clinician when its bound human is a tenant administrator — the JWT branch`s rule, verbatim', async () => {
    userRoleAssignmentRepo.findAll.mockResolvedValue([{ id: 'ura', userId: 'admin-1', tenantId: TENANT, Roles: [{ name: 'TENANT_ADMIN' }] }]);

    const result = await make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, apiKey('admin-1'));

    expect(result.clinicianUserId).toBe(CLINICIAN);
    expect(userRoleAssignmentRepo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'admin-1', tenantId: TENANT }) }),
    );
  });

  it('is refused when the bound human holds only clinical roles', async () => {
    userRoleAssignmentRepo.findAll.mockResolvedValue([{ id: 'ura', userId: 'doc-9', tenantId: TENANT, Roles: [{ name: 'DOCTOR' }] }]);

    expect(await refusalCode(() => make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, apiKey('doc-9')))).toBe(
      'DNA_INGEST_CLINICIAN_NOT_ALLOWED',
    );
  });

  it('is refused when the key is bound to NOBODY — an unbound key has no human to inherit from', async () => {
    expect(await refusalCode(() => make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, apiKey(null)))).toBe(
      'DNA_INGEST_CLINICIAN_NOT_ALLOWED',
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the role read throws — an unreadable role list is not an admin one', async () => {
    userRoleAssignmentRepo.findAll.mockRejectedValue(new Error('db down'));

    expect(await refusalCode(() => make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, apiKey('admin-1')))).toBe(
      'DNA_INGEST_CLINICIAN_NOT_ALLOWED',
    );
  });

  it('leaves the SERVICE ACCOUNT plane alone — it is bound to a tenant, not to a person', async () => {
    clsStore.user = undefined;

    const result = await make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, serviceAccount);

    expect(result.clinicianUserId).toBe(CLINICIAN);
    expect(userRoleAssignmentRepo.findAll).not.toHaveBeenCalled();
  });

  /**
   * The job payload's `userId` becomes the report's `createdBy` AND is one half of the PERSONAL
   * job route's owner disjunct (`dna-writing-style-job-stream.ts`). Stamping the machine's bound
   * human there would hand that human a read of a profile they are not the subject of, through a
   * route this ticket never touched.
   */
  it('stamps the CLINICIAN as the job`s user, never the credential`s bound human', async () => {
    await make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, apiKey(CLINICIAN));

    expect(payload()).toMatchObject({ doctorId: CLINICIAN, userId: CLINICIAN, requestedBy: { credentialClass: 'api-key', principalId: 'key-1' } });
  });
});

/**
 * L5/F3 — `@IsISO8601()` accepts strings `Date.parse` cannot read (`2026-W01`, `20260901`), and
 * the service used to compute the response window from `Date.parse` and hand the batch to a
 * processor that sorts by it. The result was a 500 AFTER the job was enqueued: an accepted
 * request, an un-runnable job, and a window of `Invalid Date`.
 */
describe('every `writtenAt` must be a moment in time, not merely ISO-8601-shaped', () => {
  it.each(['2026-W01', '20260901', 'yesterday'])('refuses %s before anything is queued', async (writtenAt) => {
    expect(await refusalCode(() => make().ingestWritingSamples({ items: [{ text: 'Note.', writtenAt }] }, jwt()))).toBe(
      'DNA_INGEST_WRITTEN_AT_INVALID',
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('names the offending item so a caller can fix the right one', async () => {
    try {
      await make().ingestWritingSamples({ items: [{ text: 'a', writtenAt: '2026-09-01T09:00:00.000Z' }, { text: 'b', writtenAt: '2026-W01' }] }, jwt());
      throw new Error('expected a refusal');
    } catch (error) {
      const response = (error as { getResponse?: () => unknown }).getResponse?.() as { message?: string };
      expect(response.message).toContain('items[1]');
    }
  });

  it('still accepts a date-only `writtenAt` — a real moment, just a coarse one', async () => {
    const result = await make().ingestWritingSamples({ items: [{ text: 'Note.', writtenAt: '2026-09-01' }] }, jwt());

    expect(result.acceptedItems).toBe(1);
  });
});

/**
 * L5/F5 — `Idempotency-Key`.
 *
 * `@arcaai/vox-node` advertises the header AND lifts its POST retry guard when one is sent
 * (`hasIdempotencyKey`), so a retried 503 used to create a SECOND analysis job for the same batch
 * — two LLM calls, two reports, two bills. The job id is therefore DERIVED from the key so the
 * retry addresses the job the first attempt created.
 */
describe('an idempotency key makes a retry join the original enqueue', () => {
  it('derives the same job id for the same (tenant, principal, key), and adds only once', async () => {
    const first = await make().ingestWritingSamples({ items }, jwt(), 'batch-2026-09-01');
    queue.getJob.mockResolvedValue({ id: first.jobId, data: payload() });

    const second = await make().ingestWritingSamples({ items }, jwt(), 'batch-2026-09-01');

    expect(second.jobId).toBe(first.jobId);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('gives a DIFFERENT principal a different job — a key is idempotent for its own caller only', async () => {
    const mine = await make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, apiKey(CLINICIAN), 'shared-key');
    const theirs = await make().ingestWritingSamples({ clinicianUserId: CLINICIAN, items }, serviceAccount, 'shared-key');

    expect(theirs.jobId).not.toBe(mine.jobId);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('mints a fresh job id when no key is sent — the pre-existing behaviour', async () => {
    const a = await make().ingestWritingSamples({ items }, jwt());
    const b = await make().ingestWritingSamples({ items }, jwt());

    expect(a.jobId).not.toBe(b.jobId);
    expect(queue.getJob).not.toHaveBeenCalled();
  });
});
