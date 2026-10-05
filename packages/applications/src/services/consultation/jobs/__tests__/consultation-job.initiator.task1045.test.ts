/**
 * TASK-1045 (owner decision 2026-10-06) — a consultation job records WHO STARTED it.
 *
 * `userId` on a job is the CLINICIAN (TASK-933: a machine-initiated note is still the doctor's
 * job), so it cannot answer "may this caller cancel it". `initiatorId` is the acting principal at
 * creation — a user id, or a service-account id — and is what lets a service account cancel the
 * jobs it started and nothing else. Absent ⇒ not stamped (never fabricated from `userId`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Queue } from 'bullmq';
import { Observable } from 'rxjs';
import { ConsultationJobService } from '../consultation-job.service';

vi.mock('uuidv7', () => ({ uuidv7: vi.fn(() => 'job-1') }));

const TENANT = 'tenant-1';
const DOCTOR = '70000000-0000-0000-0000-000000000040';
const SVC_ACCOUNT_ID = 'e0000000-0000-0000-0000-000000000001';

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('ConsultationJobService — initiatorId', () => {
  let service: ConsultationJobService;
  let cache: { get: any; setex: any; publish: any; eval: any; del: any };

  const storedRecord = (): Record<string, unknown> => {
    const calls = cache.setex.mock.calls.filter((args: unknown[]) => String(args[0]).startsWith('consultation_job:'));
    expect(calls.length).toBe(1);
    return JSON.parse(String(calls[0][2])) as Record<string, unknown>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    cache = {
      get: vi.fn().mockResolvedValue(null),
      setex: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(undefined),
      eval: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(undefined),
    };
    const queue = { add: vi.fn().mockResolvedValue(undefined), getJob: vi.fn().mockResolvedValue(null) };
    const subscriber = { subscribeToChannel: vi.fn().mockResolvedValue(new Observable(() => {})), unsubscribeFromChannel: vi.fn() };
    service = new ConsultationJobService(queue as unknown as Queue, cache as any, subscriber as any);
  });

  it('a machine-started pre-summary job keeps the clinician as userId and the service account as initiatorId', async () => {
    await service.createPreSummaryJob('c-1', TENANT, DOCTOR, {}, undefined, undefined, SVC_ACCOUNT_ID);

    expect(storedRecord()).toMatchObject({ userId: DOCTOR, initiatorId: SVC_ACCOUNT_ID, tenantId: TENANT });
  });

  it('a human-started pre-summary job records the human as initiatorId', async () => {
    await service.createPreSummaryJob('c-1', TENANT, DOCTOR, {}, undefined, undefined, DOCTOR);

    expect(storedRecord()).toMatchObject({ userId: DOCTOR, initiatorId: DOCTOR });
  });

  it('a machine-started harness note job keeps the clinician as userId and the service account as initiatorId', async () => {
    await service.registerHarnessNoteJob('harness-doc-1', 'c-1', TENANT, DOCTOR, SVC_ACCOUNT_ID);

    expect(storedRecord()).toMatchObject({ jobId: 'harness-doc-1', userId: DOCTOR, initiatorId: SVC_ACCOUNT_ID });
  });

  it('a human-started harness note job records the human as initiatorId', async () => {
    await service.registerHarnessNoteJob('harness-doc-1', 'c-1', TENANT, DOCTOR, DOCTOR);

    expect(storedRecord()).toMatchObject({ userId: DOCTOR, initiatorId: DOCTOR });
  });

  it('no initiator given ⇒ none stamped (never copied from userId)', async () => {
    await service.registerHarnessNoteJob('harness-doc-1', 'c-1', TENANT, DOCTOR);

    expect(storedRecord()).not.toHaveProperty('initiatorId');
  });

  it('getJobStatus returns initiatorId so the owner check can read it', async () => {
    cache.get.mockResolvedValueOnce(
      JSON.stringify({
        jobId: 'job-1',
        type: 'SUMMARY',
        status: 'RUNNING',
        progress: 10,
        createdAt: new Date().toISOString(),
        tenantId: TENANT,
        userId: DOCTOR,
        initiatorId: SVC_ACCOUNT_ID,
      }),
    );

    await expect(service.getJobStatus('job-1')).resolves.toMatchObject({ userId: DOCTOR, initiatorId: SVC_ACCOUNT_ID });
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
