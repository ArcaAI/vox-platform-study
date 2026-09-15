/**
 * TASK-972 Lane 1 — WHO is recorded as the clinician who attested a clinical note.
 *
 * `approveSummary` stamped `approvedBy = this.requestUserId` and threw when absent, so a
 * service account could not sign at all — and if it ever could, the MACHINE would have been
 * recorded as the attesting clinician. Both halves are wrong: a machine must be able to submit
 * a clinician's sign-off, and it must never BE the clinician.
 *
 * The rule is TASK-974's `resolveIngestClinician`, applied to the three write paths of the
 * finish half of the consultation plane (`updateSummary` / `approveSummary` / `closeConsultation`).
 * These specs pin the resolver itself; the service-level specs pin that the resolved clinician
 * reaches `approvedBy` / `attestedBy` while the CREDENTIAL is recorded beside them.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { resolveAttributedClinician, type ClinicalCaller } from '../clinician-attribution';

const TENANT = 'tenant-1';
const CALLER = 'doctor-1';
const OTHER = 'doctor-2';

const jwt = (principalId = CALLER): ClinicalCaller => ({ credentialClass: 'jwt', principalId });
const apiKey = (boundUserId: string | null = CALLER): ClinicalCaller => ({ credentialClass: 'api-key', principalId: 'key-1', boundUserId });
const serviceAccount: ClinicalCaller = { credentialClass: 'service-account', principalId: 'svc-1' };

/** A tenant-scoped role reader — the ONLY role source this resolver consults for a third party. */
const roles = (byUser: Record<string, string[]>) => vi.fn(async (userId: string) => byUser[userId] ?? []);

const session = (id: string | null, sessionRoles: string[] = []) => (id ? { id, roles: sessionRoles } : null);

describe('resolveAttributedClinician — machine callers', () => {
  it('REFUSES a service account that names nobody (400) — a machine is never the clinician', async () => {
    await expect(
      resolveAttributedClinician({ named: undefined, caller: serviceAccount, tenantId: TENANT, requestUser: session(null), readTenantRoles: roles({}) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REFUSES an API key that names nobody (400)', async () => {
    await expect(
      resolveAttributedClinician({ named: undefined, caller: apiKey(), tenantId: TENANT, requestUser: session(CALLER), readTenantRoles: roles({}) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a SERVICE ACCOUNT name any clinician of its working tenant', async () => {
    const resolved = await resolveAttributedClinician({
      named: OTHER,
      caller: serviceAccount,
      tenantId: TENANT,
      requestUser: session(null),
      readTenantRoles: roles({}),
    });
    expect(resolved).toBe(OTHER);
  });

  it('lets an API KEY name only the human it is bound to', async () => {
    const resolved = await resolveAttributedClinician({
      named: CALLER,
      caller: apiKey(CALLER),
      tenantId: TENANT,
      requestUser: session(CALLER),
      readTenantRoles: roles({}),
    });
    expect(resolved).toBe(CALLER);
  });

  it('REFUSES an API key naming another human when its own human holds no admin role (400)', async () => {
    await expect(
      resolveAttributedClinician({ named: OTHER, caller: apiKey(CALLER), tenantId: TENANT, requestUser: session(CALLER), readTenantRoles: roles({}) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets an API key bound to a TENANT_ADMIN name another clinician — a credential never exceeds its human', async () => {
    const readTenantRoles = roles({ [CALLER]: ['TENANT_ADMIN'] });
    const resolved = await resolveAttributedClinician({
      named: OTHER,
      caller: apiKey(CALLER),
      tenantId: TENANT,
      requestUser: session(CALLER),
      readTenantRoles,
    });
    expect(resolved).toBe(OTHER);
    // The role read is TENANT-SCOPED: a user who administers tenant B is nobody in tenant A.
    expect(readTenantRoles).toHaveBeenCalledWith(CALLER, TENANT);
  });

  it('REFUSES an UNBOUND API key naming anyone (400) — there is no human to inherit from', async () => {
    await expect(
      resolveAttributedClinician({ named: OTHER, caller: apiKey(null), tenantId: TENANT, requestUser: session(null), readTenantRoles: roles({}) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails CLOSED when the bound human`s roles cannot be read', async () => {
    const readTenantRoles = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(
      resolveAttributedClinician({ named: OTHER, caller: apiKey(CALLER), tenantId: TENANT, requestUser: session(CALLER), readTenantRoles }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('resolveAttributedClinician — human callers', () => {
  it('resolves to SELF when a human names nobody', async () => {
    const resolved = await resolveAttributedClinician({
      named: undefined,
      caller: jwt(),
      tenantId: TENANT,
      requestUser: session(CALLER),
      readTenantRoles: roles({}),
    });
    expect(resolved).toBe(CALLER);
  });

  it('resolves to SELF when a human names themselves, with no role read at all', async () => {
    const readTenantRoles = roles({});
    const resolved = await resolveAttributedClinician({
      named: CALLER,
      caller: jwt(),
      tenantId: TENANT,
      requestUser: session(CALLER),
      readTenantRoles,
    });
    expect(resolved).toBe(CALLER);
    expect(readTenantRoles).not.toHaveBeenCalled();
  });

  it('REFUSES a clinician naming another clinician (400, not 403 — there is no id to protect)', async () => {
    await expect(
      resolveAttributedClinician({ named: OTHER, caller: jwt(), tenantId: TENANT, requestUser: session(CALLER), readTenantRoles: roles({}) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a TENANT_ADMIN of THIS tenant name another clinician', async () => {
    const resolved = await resolveAttributedClinician({
      named: OTHER,
      caller: jwt(),
      tenantId: TENANT,
      requestUser: session(CALLER),
      readTenantRoles: roles({ [CALLER]: ['TENANT_ADMIN'] }),
    });
    expect(resolved).toBe(OTHER);
  });

  it('lets a SUPER_ADMIN session name another clinician without a tenant role assignment', async () => {
    const readTenantRoles = roles({});
    const resolved = await resolveAttributedClinician({
      named: OTHER,
      caller: jwt(),
      tenantId: TENANT,
      requestUser: session(CALLER, ['SUPER_ADMIN']),
      readTenantRoles,
    });
    expect(resolved).toBe(OTHER);
  });

  it('REFUSES a human with no user context at all (400)', async () => {
    await expect(
      resolveAttributedClinician({ named: undefined, caller: jwt(), tenantId: TENANT, requestUser: session(null), readTenantRoles: roles({}) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('classifies an ABSENT caller as a human JWT — every pre-existing call site keeps its behaviour', async () => {
    const resolved = await resolveAttributedClinician({
      named: undefined,
      caller: undefined,
      tenantId: TENANT,
      requestUser: session(CALLER),
      readTenantRoles: roles({}),
    });
    expect(resolved).toBe(CALLER);
  });
});

describe('assertAttributedClinicianInTenant — the cross-tenant posture', () => {
  it('is a 404, never a 403, for a clinician outside the tenant', async () => {
    const { assertAttributedClinicianInTenant } = await import('../clinician-attribution');
    await expect(
      assertAttributedClinicianInTenant(
        {
          userRoleAssignmentRepository: { findFirst: vi.fn().mockResolvedValue(null) } as never,
          userDepartmentRepository: { findFirst: vi.fn().mockResolvedValue(null) } as never,
          userRepository: { findFirst: vi.fn().mockResolvedValue(null) } as never,
        },
        OTHER,
        TENANT,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fails CLOSED (404) when the membership repositories are not wired', async () => {
    const { assertAttributedClinicianInTenant } = await import('../clinician-attribution');
    await expect(assertAttributedClinicianInTenant({}, OTHER, TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });
});
