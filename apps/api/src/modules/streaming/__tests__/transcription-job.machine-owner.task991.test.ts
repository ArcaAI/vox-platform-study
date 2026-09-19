/**
 * TASK-991 W2-1 — `POST audio/transcription-jobs/transcribe` for a MACHINE caller.
 *
 * The defect, measured live: a service account got `400 "User context is required. Ensure you are
 * authenticated."` The handler resolved the job's owner through `getUserId()`, which reads CLS
 * `user` — a key `UnifiedAuthGuard` deliberately never populates for a machine — while
 * `route-manifest.json` declared the route `svcScopes: ["svc:stt:transcription:write"]` with
 * `forbidServiceAccount: false`. The platform advertised a route it then refused, and the
 * console's integration panel is generated from that same manifest.
 *
 * The fix is the rule `POST dna-writing-styles/ingest` already states, under the same field name:
 * a machine NAMES the clinician it acts for, and the platform records the machine beside them.
 * These tests pin the four outcomes that rule has to produce, plus the two invariants the
 * implementation leans on — a credential never exceeds its human, and an unwired verifier fails
 * closed rather than accepting an unverified clinician.
 *
 * Every case drives the DEPRECATED `pipelineId` path on purpose: it is the shortest route through
 * the handler that still reaches the dispatch, and the owner resolution is identical on both.
 */
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobController } from '../transcription-job.controller';
import { wavFixture } from './wav-fixture';

const TENANT = 'tenant-1';
const CLINICIAN = '70000000-0000-0000-0000-000000000040';
const OTHER_CLINICIAN = '70000000-0000-0000-0000-000000000041';
const FOREIGN_USER = '70000000-0000-0000-0000-0000000000ff';
const SVC_ACCOUNT_ID = 'e0000000-0000-0000-0000-000000000001';
const API_KEY_ID = 'k0000000-0000-0000-0000-000000000001';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A CLS double that answers by key, exactly as the controller reads it. */
const clsFor = (store: Record<string, unknown>) => ({ get: vi.fn((key?: string) => (key === undefined ? undefined : store[key])) });

/**
 * The role-assignment service double.
 *
 * `members` are the users the tenant has an ENABLED assignment for — membership, which is what
 * `findActiveAssignmentForUserInTenant` answers and what decides 404 vs accepted. `adminOf` maps a
 * user to the tenant they administer, so the API-key widening can be exercised BOTH ways without a
 * second double.
 */
function roleAssignmentsDouble(members: string[], adminOf: Record<string, string> = {}) {
  return {
    findActiveAssignmentForUserInTenant: vi.fn(async (userId: string, tenantId: string) =>
      members.includes(userId) && tenantId === TENANT ? { id: 'ura-1', userId, roleId: 'role-1', tenantId, resourceStatus: 'ENABLED' } : null,
    ),
    fetchAllByUserId: vi.fn(async ({ userId }: { userId: string }) => ({
      data: adminOf[userId]
        ? [{ tenantId: adminOf[userId], Roles: [{ name: 'TENANT_ADMIN' }] }]
        : [{ tenantId: TENANT, Roles: [{ name: 'DOCTOR' }] }],
    })),
  };
}

function build(options: {
  cls: Record<string, unknown>;
  members?: string[];
  adminOf?: Record<string, string>;
  /** Omit the role-assignment service entirely — the unwired-gateway case. */
  withoutRoleAssignments?: boolean;
  inFlight?: number;
}) {
  const jobService = {
    createBatchJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }),
    getStatusCountsForOwner: vi
      .fn()
      .mockResolvedValue({ queued: options.inFlight ?? 0, processing: 0, completed: 0, failed: 0, cancelled: 0, dead: 0 }),
    failJob: vi.fn().mockResolvedValue(undefined),
  };
  const realtimeService = { dispatchDramatiqJob: vi.fn().mockResolvedValue(undefined) };
  const roleAssignments = roleAssignmentsDouble(options.members ?? [CLINICIAN, OTHER_CLINICIAN], options.adminOf ?? {});

  const controller = new TranscriptionJobController(
    jobService as any,
    realtimeService as any,
    {} as any, // sessionService
    clsFor(options.cls) as any,
    { putObject: vi.fn().mockResolvedValue(undefined), resolveDescriptor: vi.fn().mockResolvedValue(null) } as any, // blobStorage
    { getBucketByPurpose: vi.fn().mockResolvedValue(null), getBucketBySlug: vi.fn().mockResolvedValue(null) } as any, // tenantBucketService
    { getById: vi.fn().mockImplementation(async (id: string) => ({ id, tenantId: TENANT, name: 'Primary', slug: id })) } as any, // pipelineService
    {} as any, // streamTicketService
    {} as any, // streamSessionTenantBinding
    { assertConcurrencyQuota: vi.fn().mockResolvedValue(undefined) } as any, // entitlements
    { getEffective: vi.fn().mockResolvedValue({ fallbackPipelineId: null }), resolveProviderOverrides: vi.fn().mockResolvedValue({}) } as any,
    { resolve: vi.fn().mockResolvedValue({ maxFilesPerBatch: 5, maxDurationMinutes: 60, maxFileSizeMb: 250, maxActiveJobsPerUser: 5 }) } as any,
    undefined, // asrResolver — absent, so `pipelineId` takes the legacy path
    options.withoutRoleAssignments ? undefined : (roleAssignments as any),
  );
  return { controller, jobService, realtimeService, roleAssignments };
}

/** The request object the guard would have populated, or `undefined` for a bare JWT call. */
const apiKeyRequest = (boundUserId: string | null) => ({ apiKey: { id: API_KEY_ID, userId: boundUserId } }) as any;

const body = (clinicianUserId?: string) => ({ pipelineId: 'pipe-1', ...(clinicianUserId ? { clinicianUserId } : {}) }) as any;

describe('transcribe — a HUMAN caller is untouched', () => {
  beforeEach(() => vi.clearAllMocks());

  it('owns their own job without naming anybody, exactly as before', async () => {
    const { controller, realtimeService, jobService, roleAssignments } = build({
      cls: { tenantId: TENANT, user: { id: CLINICIAN, tenantId: TENANT, roles: ['DOCTOR'] } },
    });

    await expect(controller.transcribeFile(wavFixture(60), body())).resolves.toMatchObject({ id: 'job-1' });

    expect(realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ userId: CLINICIAN }));
    // The in-flight cap is still counted against the CALLER, and naming nobody costs no identity
    // read at all — the ordinary path must not pay for the machine rule.
    expect(jobService.getStatusCountsForOwner).toHaveBeenCalledWith(CLINICIAN);
    expect(roleAssignments.findActiveAssignmentForUserInTenant).not.toHaveBeenCalled();
    expect(roleAssignments.fetchAllByUserId).not.toHaveBeenCalled();
  });

  it('naming THEMSELVES is the same request, not a privileged one', async () => {
    const { controller, realtimeService, roleAssignments } = build({
      cls: { tenantId: TENANT, user: { id: CLINICIAN, tenantId: TENANT, roles: ['DOCTOR'] } },
    });

    await expect(controller.transcribeFile(wavFixture(60), body(CLINICIAN))).resolves.toMatchObject({ id: 'job-1' });

    expect(realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ userId: CLINICIAN }));
    expect(roleAssignments.fetchAllByUserId).not.toHaveBeenCalled();
  });

  it('a clinician may not name a COLLEAGUE — that needs an administrator', async () => {
    const { controller, realtimeService } = build({ cls: { tenantId: TENANT, user: { id: CLINICIAN, tenantId: TENANT, roles: ['DOCTOR'] } } });

    const err = await controller.transcribeFile(wavFixture(60), body(OTHER_CLINICIAN)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'TRANSCRIBE_CLINICIAN_NOT_ALLOWED' });
    expect(realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
  });

  it('a TENANT_ADMIN may, and the job is owned by the clinician they named', async () => {
    const { controller, realtimeService, jobService } = build({
      cls: { tenantId: TENANT, user: { id: CLINICIAN, tenantId: TENANT, roles: ['TENANT_ADMIN'] } },
    });

    await expect(controller.transcribeFile(wavFixture(60), body(OTHER_CLINICIAN))).resolves.toMatchObject({ id: 'job-1' });

    expect(realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ userId: OTHER_CLINICIAN }));
    expect(jobService.getStatusCountsForOwner).toHaveBeenCalledWith(OTHER_CLINICIAN);
  });
});

describe('transcribe — a SERVICE ACCOUNT names the clinician it acts for', () => {
  beforeEach(() => vi.clearAllMocks());

  const svcCls = { tenantId: TENANT, serviceAccount: { id: SVC_ACCOUNT_ID } };

  it('is refused by NAME when it omits the field — not by the old "User context is required"', async () => {
    const { controller, realtimeService, jobService } = build({ cls: svcCls });

    const err = await controller.transcribeFile(wavFixture(60), body()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    const response = (err as BadRequestException).getResponse() as { code: string; message: string };
    expect(response.code).toBe('TRANSCRIBE_CLINICIAN_REQUIRED');
    // The message must name the field a client has to add; "user context is required" told an
    // integrator to fix their authentication, which was working.
    expect(response.message).toContain('clinicianUserId');
    expect(response.message).not.toMatch(/ensure you are authenticated/i);
    // Refused BEFORE the row, the upload and the dispatch.
    expect(jobService.createBatchJob).not.toHaveBeenCalled();
    expect(realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
  });

  it('naming a clinician of its own tenant is accepted, and that clinician owns the job', async () => {
    const { controller, realtimeService, jobService, roleAssignments } = build({ cls: svcCls });

    await expect(controller.transcribeFile(wavFixture(60), body(CLINICIAN))).resolves.toMatchObject({ id: 'job-1' });

    expect(roleAssignments.findActiveAssignmentForUserInTenant).toHaveBeenCalledWith(CLINICIAN, TENANT);
    // The dispatched `userId` is what seeds enrolled VOICE PROFILES
    // (`TranscriptionRealtimeService.resolveVoiceProfiles`), so this assertion is the one that
    // makes diarization work for a machine-submitted recording.
    expect(realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ userId: CLINICIAN }));
    // The `maxActiveJobsPerUser` cap is counted against the NAMED clinician, never the credential.
    expect(jobService.getStatusCountsForOwner).toHaveBeenCalledWith(CLINICIAN);
  });

  it('naming a user of ANOTHER tenant is 404, never 403 — the user id space is not the caller`s to probe', async () => {
    const { controller, realtimeService, jobService } = build({ cls: svcCls });

    const err = await controller.transcribeFile(wavFixture(60), body(FOREIGN_USER)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotFoundException);
    expect(jobService.createBatchJob).not.toHaveBeenCalled();
    expect(realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
  });

  it('is recognised from the REQUEST too, not only from CLS — the guard populates both', async () => {
    // The cases above drive the CLS fallback (no `req`). In production Nest injects the request
    // and `UnifiedAuthGuard` sets `serviceAccount` on it, which is the source
    // `DnaWritingStyleIngestController` trusts; this pins that the two agree.
    const { controller, realtimeService } = build({ cls: { tenantId: TENANT } });
    const req = { serviceAccount: { id: SVC_ACCOUNT_ID } } as any;

    await expect(controller.transcribeFile(wavFixture(60), body(CLINICIAN), undefined, req)).resolves.toMatchObject({ id: 'job-1' });
    expect(realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ userId: CLINICIAN }));

    const err = await controller.transcribeFile(wavFixture(60), body(), undefined, req).catch((e: unknown) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'TRANSCRIBE_CLINICIAN_REQUIRED' });
  });

  it('fails CLOSED when the gateway cannot verify the clinician at all', async () => {
    const { controller, realtimeService } = build({ cls: svcCls, withoutRoleAssignments: true });

    await expect(controller.transcribeFile(wavFixture(60), body(CLINICIAN))).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
  });
});

describe('transcribe — an API KEY never exceeds the human it is bound to', () => {
  beforeEach(() => vi.clearAllMocks());

  /** An API-key request: CLS carries the BOUND human (no roles), the request carries the key. */
  const keyCls = (boundUserId: string) => ({ tenantId: TENANT, user: { id: boundUserId, tenantId: TENANT } });

  it('keeps today`s behaviour when it names nobody: the bound human owns the job', async () => {
    const { controller, realtimeService } = build({ cls: keyCls(CLINICIAN) });

    await expect(controller.transcribeFile(wavFixture(60), body(), undefined, apiKeyRequest(CLINICIAN))).resolves.toMatchObject({ id: 'job-1' });

    expect(realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ userId: CLINICIAN }));
  });

  it('may not name a colleague when its human is an ordinary clinician', async () => {
    const { controller, realtimeService } = build({ cls: keyCls(CLINICIAN) });

    const err = await controller.transcribeFile(wavFixture(60), body(OTHER_CLINICIAN), undefined, apiKeyRequest(CLINICIAN)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'TRANSCRIBE_CLINICIAN_NOT_ALLOWED' });
    expect(realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
  });

  it('may when its human administers THIS tenant', async () => {
    const { controller, realtimeService } = build({ cls: keyCls(CLINICIAN), adminOf: { [CLINICIAN]: TENANT } });

    await expect(controller.transcribeFile(wavFixture(60), body(OTHER_CLINICIAN), undefined, apiKeyRequest(CLINICIAN))).resolves.toMatchObject({
      id: 'job-1',
    });

    expect(realtimeService.dispatchDramatiqJob).toHaveBeenCalledWith(expect.objectContaining({ userId: OTHER_CLINICIAN }));
  });

  it('may NOT when its human administers a DIFFERENT tenant — an admin of tenant B is nobody in tenant A', async () => {
    const { controller, realtimeService } = build({ cls: keyCls(CLINICIAN), adminOf: { [CLINICIAN]: 'tenant-2' } });

    const err = await controller.transcribeFile(wavFixture(60), body(OTHER_CLINICIAN), undefined, apiKeyRequest(CLINICIAN)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'TRANSCRIBE_CLINICIAN_NOT_ALLOWED' });
    expect(realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
  });
});
