/**
 * TASK-950 §D-6 — what the CONTROLLER may decide about `POST /consultations/open`, and what it
 * must hand on.
 *
 * The clinician a service account acts for can now arrive by two routes: `clinicianUserId`
 * (TASK-933) or a STAFF ID inside the schema-typed `context` payload. Answering the second one
 * needs the tenant's effective context schema and the user directory, and a controller may
 * touch neither (rule 05: no business logic, no repository access). So the split is:
 *
 *  · the controller still answers the two refusals it can answer ALONE — a human that named a
 *    clinician, and a machine that named nobody by ANY route (no `clinicianUserId`, no
 *    `context`) — because neither needs a tenant read to be certain;
 *  · everything else is DEFERRED: the controller passes `null` and the service settles it.
 *    `null` here means "not the controller's to decide", never "no clinician".
 *
 * The regression this file guards is the tempting shortcut in either direction: refusing a
 * machine that sent a context payload (which may well identify a clinician) would break the
 * feature outright, and deferring the human refusal would move an impersonation check off the
 * edge and into a layer that has already stopped asking.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ConsultationController } from '../consultation.controller';

const TENANT = 'tenant-1';
const DOCTOR = '70000000-0000-0000-0000-000000000040';
const OTHER_DOCTOR = '70000000-0000-0000-0000-000000000010';
const SVC_ACCOUNT_ID = 'e0000000-0000-0000-0000-000000000001';

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildController(opts: { principal: 'user' | 'serviceAccount'; userId?: string } = { principal: 'serviceAccount' }) {
  const consultationService = {
    getById: vi.fn(),
    getByIdWithRelations: vi.fn(),
    getOrCreate: vi.fn().mockResolvedValue({ id: 'c-1', doctorId: DOCTOR, patientId: 'p-1', tenantId: TENANT }),
  };

  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'tenantId') return TENANT;
      if (key === 'user') return opts.principal === 'user' ? { id: opts.userId ?? DOCTOR, tenantId: TENANT } : null;
      if (key === 'serviceAccount') return opts.principal === 'serviceAccount' ? { id: SVC_ACCOUNT_ID, scopes: [] } : undefined;
      return undefined;
    }),
  };

  const controller = new ConsultationController(
    consultationService as any,
    {} as any, // contextService
    {} as any, // summaryService
    {} as any, // chainSummaryService
    {} as any, // jobService
    {} as any, // noteGenerationService
    {} as any, // timelineService
    cls as any,
    { can: vi.fn().mockReturnValue(false), cannot: vi.fn().mockReturnValue(true) } as any, // policyEngine
    { findAll: vi.fn().mockResolvedValue([]) } as any, // globalSettingRepository
    {} as any, // tagService
    {} as any, // liveDocumentationService
    {} as any, // highlightService
    {} as any, // harnessProgressService
    {} as any, // harnessAssuranceService
    {} as any, // harnessLiveAssistService
    {} as any, // redisSubscriber
    {} as any, // loopContextSignalService
    {} as any, // documentSectionService
  );

  return { controller, consultationService };
}

const CONTEXT = { vitals: { consultant_id: 'DR-950-1', heartRate: 72 } };

describe('ConsultationController.open — who decides the clinician', () => {
  it('defers to the service when a machine sends a context payload and no clinicianUserId', async () => {
    const { controller, consultationService } = buildController();

    await controller.open({ patientId: 'p-1', context: CONTEXT } as any);

    // `null`, not a thrown 400: the payload MAY carry the schema-declared identity value, and
    // only the service can resolve the tenant's effective schema to find out.
    expect(consultationService.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({ context: CONTEXT }), null);
  });

  it('still passes a named clinician straight through — the TASK-933 shape is untouched', async () => {
    const { controller, consultationService } = buildController();

    await controller.open({ patientId: 'p-1', clinicianUserId: DOCTOR, context: CONTEXT } as any);

    expect(consultationService.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({ clinicianUserId: DOCTOR }), DOCTOR);
  });

  it('refuses at the edge when a machine identifies nobody by ANY route', async () => {
    const { controller, consultationService } = buildController();

    await expect(controller.open({ patientId: 'p-1' } as any)).rejects.toMatchObject({ response: { code: 'CLINICIAN_REQUIRED' } });
    await expect(controller.open({ patientId: 'p-1' } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(consultationService.getOrCreate).not.toHaveBeenCalled();
  });

  it('refuses an EMPTY context object too — an envelope with no kinds identifies nobody', async () => {
    const { controller, consultationService } = buildController();

    await expect(controller.open({ patientId: 'p-1', context: {} } as any)).rejects.toMatchObject({ response: { code: 'CLINICIAN_REQUIRED' } });
    expect(consultationService.getOrCreate).not.toHaveBeenCalled();
  });

  it('the message names BOTH routes, so an integrator learns the second one exists', async () => {
    const { controller } = buildController();

    await expect(controller.open({ patientId: 'p-1' } as any)).rejects.toMatchObject({
      response: { message: expect.stringContaining('staff identifier') },
    });
  });

  it('a HUMAN caller that names a clinician is still refused at the edge', async () => {
    const { controller, consultationService } = buildController({ principal: 'user', userId: DOCTOR });

    await expect(controller.open({ patientId: 'p-1', clinicianUserId: OTHER_DOCTOR, context: CONTEXT } as any)).rejects.toMatchObject({
      response: { code: 'CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER' },
    });
    expect(consultationService.getOrCreate).not.toHaveBeenCalled();
  });

  it('a HUMAN caller may send a context payload and still opens as themselves', async () => {
    const { controller, consultationService } = buildController({ principal: 'user', userId: DOCTOR });

    await controller.open({ patientId: 'p-1', context: CONTEXT } as any);

    // The payload is forwarded verbatim — the service validates it as content and ignores the
    // identity field for a human (D-5). The controller never strips or rewrites a body field.
    expect(consultationService.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({ context: CONTEXT }), DOCTOR);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
