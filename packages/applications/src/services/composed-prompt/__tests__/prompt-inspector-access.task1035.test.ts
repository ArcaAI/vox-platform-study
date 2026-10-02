/**
 * OD-9 access — the Prompt Inspector and the composed-prompt reads return a consultation's prompt,
 * PHI included, so they are for a SUPER_ADMIN or a TENANT_ADMIN of the working tenant only.
 *
 *  - a doctor (who may hold `read:Consultation`) is 403;
 *  - a tenant admin is recognised from the TENANT-SCOPED role assignments, never the JWT's
 *    cross-tenant role list — an admin of another tenant is 403 here;
 *  - a super admin passes; a service account (the admin plane's machine identity, bound to its
 *    working tenant) passes;
 *  - the gate does not vary by row, so it runs FIRST: a doctor probing another tenant's id gets
 *    the same 403 as for its own, and no row is read.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptPreviewService } from '../../consultation/prompt-preview/prompt-preview.service';
import { ComposedPromptService } from '../composed-prompt.service';
import { assertPromptInspectorAccess } from '../prompt-inspector-access';

const TENANT = 'tenant-a';
const clsStore: Record<string, unknown> = {};
const cls = { get: vi.fn((key: string) => clsStore[key]), set: vi.fn() };
const events = { emit: vi.fn() };
const roleAssignments = { findAll: vi.fn() };

const DOCTOR = { id: 'doctor-1', roles: ['DOCTOR'] };
const TENANT_ADMIN = { id: 'tadmin-1', roles: ['TENANT_ADMIN'] };
const SUPER_ADMIN = { id: 'sadmin-1', roles: ['SUPER_ADMIN'] };

function assignmentsFor(userId: string, tenantId: string): Array<{ Roles: Array<{ name: string }> }> {
  if (userId === TENANT_ADMIN.id && tenantId === TENANT) return [{ Roles: [{ name: 'TENANT_ADMIN' }] }];
  if (userId === DOCTOR.id && tenantId === TENANT) return [{ Roles: [{ name: 'DOCTOR' }] }];
  return [];
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(clsStore)) delete clsStore[key];
  clsStore.tenantId = TENANT;
  roleAssignments.findAll.mockImplementation(async ({ where }: { where: { userId: string; tenantId: string } }) =>
    assignmentsFor(where.userId, where.tenantId),
  );
});

describe('assertPromptInspectorAccess', () => {
  const check = (user: unknown, extra: Record<string, unknown> = {}) =>
    assertPromptInspectorAccess({ user: user as never, tenantId: TENANT, roleAssignments: roleAssignments as never, ...extra });

  it('a doctor is 403', async () => {
    await expect(check(DOCTOR)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a tenant admin of THIS tenant passes, read from the tenant-scoped assignments', async () => {
    await expect(check(TENANT_ADMIN)).resolves.toBeUndefined();
    expect(roleAssignments.findAll).toHaveBeenCalledWith({ where: expect.objectContaining({ userId: TENANT_ADMIN.id, tenantId: TENANT }) });
  });

  it('a TENANT_ADMIN role claim with no assignment in this tenant is 403', async () => {
    await expect(
      assertPromptInspectorAccess({ user: TENANT_ADMIN, tenantId: 'tenant-b', roleAssignments: roleAssignments as never }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a super admin passes without a role read', async () => {
    await expect(check(SUPER_ADMIN)).resolves.toBeUndefined();
    expect(roleAssignments.findAll).not.toHaveBeenCalled();
  });

  it('a service account passes', async () => {
    await expect(check(undefined, { serviceAccount: { id: 'svc-1' } })).resolves.toBeUndefined();
  });

  it('fails closed: no user, an unreadable role list, or no repository is 403', async () => {
    await expect(check(undefined)).rejects.toBeInstanceOf(ForbiddenException);
    roleAssignments.findAll.mockRejectedValueOnce(new Error('db down'));
    await expect(check(TENANT_ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(assertPromptInspectorAccess({ user: TENANT_ADMIN, tenantId: TENANT })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ComposedPromptService — the reads are gated', () => {
  const repository = {
    findPage: vi.fn(async () => ({ data: [], count: 0 })),
    findById: vi.fn(),
    decryptText: vi.fn(async () => 'plain'),
  };
  const secrets = { getPhiTransitKeyName: () => 'hope-phi' };
  const service = () =>
    new ComposedPromptService(
      repository as never,
      {} as never,
      events as never,
      cls as never,
      secrets as never,
      undefined,
      undefined,
      roleAssignments as never,
    );
  const record = (tenantId: string) => ({
    id: 'r-1',
    tenantId,
    consultationId: 'c-1',
    agentSlug: null,
    phase: 'finalize',
    provider: 'azure',
    locality: 'cloud',
    systemCiphertext: Buffer.from('S'),
    userCiphertext: Buffer.from('U'),
    sha256: 'x',
    createdAt: new Date('2026-10-01T00:00:00Z'),
  });

  it('doctor → 403 on list and on detail, and no row is read', async () => {
    clsStore.user = DOCTOR;
    await expect(service().list({})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service().getDecrypted('r-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.findPage).not.toHaveBeenCalled();
    expect(repository.findById).not.toHaveBeenCalled();
  });

  it('tenant admin → 200', async () => {
    clsStore.user = TENANT_ADMIN;
    repository.findById.mockResolvedValue(record(TENANT));
    await expect(service().list({})).resolves.toMatchObject({ count: 0 });
    await expect(service().getDecrypted('r-1')).resolves.toMatchObject({ id: 'r-1', system: 'plain' });
  });

  it('super admin → 200', async () => {
    clsStore.user = SUPER_ADMIN;
    repository.findById.mockResolvedValue(record(TENANT));
    await expect(service().list({})).resolves.toMatchObject({ count: 0 });
    await expect(service().getDecrypted('r-1')).resolves.toMatchObject({ id: 'r-1' });
  });

  it('privilege FIRST, then the 404: a doctor gets 403 for another tenant`s id, an admin gets 404', async () => {
    repository.findById.mockResolvedValue(record('tenant-z'));
    clsStore.user = DOCTOR;
    await expect(service().getDecrypted('r-1')).rejects.toBeInstanceOf(ForbiddenException);
    clsStore.user = TENANT_ADMIN;
    await expect(service().getDecrypted('r-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PromptPreviewService — the preview is gated', () => {
  const consultations = { findById: vi.fn() };
  const harness = {
    previewAssembly: vi.fn(async () => ({ systemPrompt: 's', userPrompt: 'u', resolvedFrom: 'agent', selected: [], excluded: [], blocks: [] })),
  };
  const detector = { detect: vi.fn(async () => []) };
  const service = () =>
    new PromptPreviewService(
      consultations as never,
      {} as never,
      harness as never,
      detector as never,
      events as never,
      cls as never,
      undefined,
      undefined,
      undefined,
      roleAssignments as never,
    );

  beforeEach(() => {
    consultations.findById.mockResolvedValue({ id: 'c-1', tenantId: TENANT, departmentId: null });
  });

  it('doctor → 403, and nothing is read or assembled', async () => {
    clsStore.user = DOCTOR;
    await expect(service().preview('c-1', { phase: 'finalize' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(consultations.findById).not.toHaveBeenCalled();
    expect(harness.previewAssembly).not.toHaveBeenCalled();
  });

  it('tenant admin → 200', async () => {
    clsStore.user = TENANT_ADMIN;
    await expect(service().preview('c-1', { phase: 'finalize' })).resolves.toMatchObject({ system: 's', user: 'u' });
  });

  it('super admin → 200', async () => {
    clsStore.user = SUPER_ADMIN;
    await expect(service().preview('c-1', { phase: 'finalize' })).resolves.toMatchObject({ system: 's', user: 'u' });
  });

  it('privilege FIRST: a doctor previewing another tenant`s consultation is 403; an admin gets 404', async () => {
    consultations.findById.mockResolvedValue({ id: 'c-1', tenantId: 'tenant-z', departmentId: null });
    clsStore.user = DOCTOR;
    await expect(service().preview('c-1', { phase: 'finalize' })).rejects.toBeInstanceOf(ForbiddenException);
    clsStore.user = TENANT_ADMIN;
    await expect(service().preview('c-1', { phase: 'finalize' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
