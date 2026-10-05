/**
 * TASK-1045 (owner decision 2026-10-06) — every note-job START records its initiator.
 *
 * The job stays filed under the CLINICIAN (`userId`, TASK-933); `initiatorId` is the acting
 * principal — the human, or the service account — which is what lets a service account cancel the
 * jobs it started. The controller is built bare and only the two START handlers are exercised.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConsultationController } from '../consultation.controller';

const TENANT = '10000000-0000-0000-0000-000000000001';
const DOCTOR = '70000000-0000-0000-0000-000000000040';
const SVC_ACCOUNT_ID = 'e0000000-0000-0000-0000-000000000001';

function build(principal: { user?: { id: string }; serviceAccount?: { id: string } }) {
  const noteGenerationService = { generate: vi.fn(async () => ({ generator: 'harness', harnessJobId: 'harness-doc-1' })) };
  const consultationJobService = {
    registerHarnessNoteJob: vi.fn(),
    runIdempotent: vi.fn(async (_scope: unknown, _input: unknown, create: () => Promise<unknown>) => ({ value: await create(), replayed: false })),
    createPreSummaryJob: vi.fn(async () => ({ jobId: 'pre-1', status: 'PENDING', sseUrl: '', estimatedSeconds: 30 })),
  };
  const values: Record<string, unknown> = { tenantId: TENANT, ...principal };
  const controller = Object.create(ConsultationController.prototype) as ConsultationController;
  Object.assign(controller, {
    noteGenerationService,
    consultationJobService,
    cls: { get: vi.fn((key: string) => values[key]) },
    logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
    verifyConsultationOwnership: vi.fn(async () => ({ doctorId: DOCTOR, patientId: 'p' })),
  });
  return { controller, consultationJobService };
}

describe('note-job starts stamp the initiator', () => {
  it('pre-summary started by a service account: filed under the doctor, initiated by the machine', async () => {
    const { controller, consultationJobService } = build({ serviceAccount: { id: SVC_ACCOUNT_ID } });

    await controller.generatePreSummaryAsync('c-1', {} as never);

    expect(consultationJobService.createPreSummaryJob).toHaveBeenCalledWith(
      'c-1',
      TENANT,
      DOCTOR,
      expect.any(Object),
      undefined,
      undefined,
      SVC_ACCOUNT_ID,
    );
  });

  it('pre-summary started by a human: the human is the initiator', async () => {
    const { controller, consultationJobService } = build({ user: { id: DOCTOR } });

    await controller.generatePreSummaryAsync('c-1', {} as never);

    expect(consultationJobService.createPreSummaryJob).toHaveBeenCalledWith('c-1', TENANT, DOCTOR, expect.any(Object), undefined, undefined, DOCTOR);
  });

  it('summary/async records the caller as the initiator of the harness note job', async () => {
    const { controller, consultationJobService } = build({ user: { id: DOCTOR } });

    await controller.generateSummaryAsync('c-1', {} as never);

    expect(consultationJobService.registerHarnessNoteJob).toHaveBeenCalledWith('harness-doc-1', 'c-1', TENANT, DOCTOR, DOCTOR);
  });
});
