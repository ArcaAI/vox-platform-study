/**
 * TASK-933 §3.3 — `@TenantOwnedResource` owner checks with a MACHINE principal.
 *
 * Two branches of this interceptor assert an intra-tenant OWNER, not merely a tenant:
 * `StreamSession` (a live clinical audio socket belongs to one principal) and `ConsultationJob`
 * under `scope: 'creator'`. Both read CLS `user?.id` and deny when it is absent — which is the
 * correct fail-closed posture for a legacy ownerless row, and was the wrong answer for a service
 * account, whose principal is on CLS `serviceAccount` by design.
 *
 * The fix is the same one the STT controller uses when it WRITES the owner: resolve
 * `user?.id ?? serviceAccount?.id`. Both halves must move together — an interceptor that still
 * read `user` would 404 the machine on the very session it had just been recorded as owning.
 *
 * Everything else about the branch is unchanged, and is asserted here so it stays that way:
 * a foreign tenant, a different principal, and an ownerless (legacy) binding are all 404.
 */
import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { TenantOwnedResourceInterceptor } from '../tenant-owned-resource.interceptor';
import { TENANT_OWNED_RESOURCE_KEY } from '../tenant-owned-resource.decorator';

const TENANT = 'tenant-1';
const SVC_ACCOUNT_ID = 'e0000000-0000-0000-0000-000000000001';
const HUMAN_ID = '70000000-0000-0000-0000-000000000040';

/* eslint-disable @typescript-eslint/no-explicit-any */
function build(opts: {
  options: Record<string, unknown>;
  cls: Record<string, unknown>;
  binding?: { tenantId: string; userId: string | null } | null;
  jobStatus?: { tenantId?: string | null; userId?: string | null } | null;
  params?: Record<string, string>;
}) {
  const reflector = { getAllAndOverride: vi.fn((key: string) => (key === TENANT_OWNED_RESOURCE_KEY ? opts.options : undefined)) };
  const cls = { get: vi.fn((key: string) => opts.cls[key]) };
  const streamSessionTenantBinding = { lookupBinding: vi.fn().mockResolvedValue(opts.binding ?? null) };
  const consultationJobService = { getJobStatus: vi.fn().mockResolvedValue(opts.jobStatus ?? null) };

  const interceptor = new TenantOwnedResourceInterceptor(
    reflector as any,
    cls as any,
    {} as any, // tenantBucketRepository
    {} as any, // tenantStorageConfigRepository
    {} as any, // userVoiceProfileRepository
    {} as any, // transcriptionJobRepository
    {} as any, // consultationRepository
    consultationJobService as any,
    streamSessionTenantBinding as any,
  );

  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ params: opts.params ?? { sessionId: 'sess-1', jobId: 'job-1' } }) }),
  } as any;

  return { interceptor, context };
}

const STREAM_OPTS = { modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' };
const JOB_CREATOR_OPTS = { modelName: 'ConsultationJob', paramName: 'jobId', scope: 'creator' };

describe('StreamSession ownership — the owner may be a machine', () => {
  it('admits the service account that owns the binding', async () => {
    const { interceptor, context } = build({
      options: STREAM_OPTS,
      cls: { tenantId: TENANT, serviceAccount: { id: SVC_ACCOUNT_ID } },
      binding: { tenantId: TENANT, userId: SVC_ACCOUNT_ID },
    });

    await expect(interceptor.assertAccess(context)).resolves.toBeUndefined();
  });

  it('still admits the human that owns the binding', async () => {
    const { interceptor, context } = build({
      options: STREAM_OPTS,
      cls: { tenantId: TENANT, user: { id: HUMAN_ID } },
      binding: { tenantId: TENANT, userId: HUMAN_ID },
    });

    await expect(interceptor.assertAccess(context)).resolves.toBeUndefined();
  });

  it('404s a DIFFERENT service account in the same tenant — a machine gets no wider reach than a colleague', async () => {
    const { interceptor, context } = build({
      options: STREAM_OPTS,
      cls: { tenantId: TENANT, serviceAccount: { id: 'e0000000-0000-0000-0000-0000000000ff' } },
      binding: { tenantId: TENANT, userId: SVC_ACCOUNT_ID },
    });

    await expect(interceptor.assertAccess(context)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s a machine probing a human's session, and a human probing a machine's", async () => {
    const machineProbingHuman = build({
      options: STREAM_OPTS,
      cls: { tenantId: TENANT, serviceAccount: { id: SVC_ACCOUNT_ID } },
      binding: { tenantId: TENANT, userId: HUMAN_ID },
    });
    await expect(machineProbingHuman.interceptor.assertAccess(machineProbingHuman.context)).rejects.toBeInstanceOf(NotFoundException);

    const humanProbingMachine = build({
      options: STREAM_OPTS,
      cls: { tenantId: TENANT, user: { id: HUMAN_ID } },
      binding: { tenantId: TENANT, userId: SVC_ACCOUNT_ID },
    });
    await expect(humanProbingMachine.interceptor.assertAccess(humanProbingMachine.context)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s a cross-tenant session even when the owner id matches', async () => {
    const { interceptor, context } = build({
      options: STREAM_OPTS,
      cls: { tenantId: TENANT, serviceAccount: { id: SVC_ACCOUNT_ID } },
      binding: { tenantId: 'tenant-other', userId: SVC_ACCOUNT_ID },
    });

    await expect(interceptor.assertAccess(context)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s an OWNERLESS legacy binding — owner unproven stays a refusal', async () => {
    const { interceptor, context } = build({
      options: STREAM_OPTS,
      cls: { tenantId: TENANT, serviceAccount: { id: SVC_ACCOUNT_ID } },
      binding: { tenantId: TENANT, userId: null },
    });

    await expect(interceptor.assertAccess(context)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ConsultationJob scope:'creator' — the creator may be a machine", () => {
  it('admits the service account that created the job', async () => {
    const { interceptor, context } = build({
      options: JOB_CREATOR_OPTS,
      cls: { tenantId: TENANT, serviceAccount: { id: SVC_ACCOUNT_ID } },
      jobStatus: { tenantId: TENANT, userId: SVC_ACCOUNT_ID },
    });

    await expect(interceptor.assertAccess(context)).resolves.toBeUndefined();
  });

  it('404s a job created by someone else', async () => {
    const { interceptor, context } = build({
      options: JOB_CREATOR_OPTS,
      cls: { tenantId: TENANT, serviceAccount: { id: SVC_ACCOUNT_ID } },
      jobStatus: { tenantId: TENANT, userId: HUMAN_ID },
    });

    await expect(interceptor.assertAccess(context)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s a legacy row with no recorded creator', async () => {
    const { interceptor, context } = build({
      options: JOB_CREATOR_OPTS,
      cls: { tenantId: TENANT, serviceAccount: { id: SVC_ACCOUNT_ID } },
      jobStatus: { tenantId: TENANT, userId: null },
    });

    await expect(interceptor.assertAccess(context)).rejects.toBeInstanceOf(NotFoundException);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
