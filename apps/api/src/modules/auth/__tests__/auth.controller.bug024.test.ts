/**
 * BUG-024 — login with a tenant identifier the platform cannot resolve.
 *
 * `TenantRepository.findFirst` THROWS `DataNotFoundException` on a miss, so the
 * `if (!tenant)` 400 in `resolveTenant` never fired: an unknown/disabled key fell
 * through to the outer catch and answered an opaque `401 Authentication failed`.
 * Owner decisions (2026-10-11): OD-2 — a miss is `400 Invalid or disabled tenant`
 * (reachable only after a valid password), an outage is 503; OD-1 — the tenant ID
 * (a UUID, what the reporter pasted) resolves like the key, membership unchanged.
 */
import { DataNotFoundException } from '@arcaai/exceptions';
import { EventTypes } from '@arcaai/domains';
import { BadRequestException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../auth.controller';

const request = { ip: '203.0.113.7', headers: { 'user-agent': 'test-agent' } };
const TENANT_ID = '01a0ec5b-bb9a-7803-8986-6fbbe05ac3c2';
let passwordHash = '';

beforeAll(async () => {
  passwordHash = await bcrypt.hash('secret', 4);
});

function build(opts: { tenantFindFirst: ReturnType<typeof vi.fn>; roles?: string[] }) {
  const emitter = { emit: vi.fn() };
  const userRoleAssignmentService = {
    findActiveRolesForUser: vi.fn(async () => (opts.roles ?? ['DOCTOR']).map((name) => ({ name }))),
    findActiveAssignmentForUserInTenant: vi.fn(async () => null),
  };
  const controller = new AuthController(
    {} as any,
    { trackAuthentication: vi.fn().mockResolvedValue(undefined) } as any,
    { getValueWithDefault: vi.fn((_k: string, d: string) => d) } as any,
    userRoleAssignmentService as any,
    { findByUsername: vi.fn(async () => ({ id: 'user-1', username: 'homeo_doc', password: passwordHash, isServiceAccount: false })) } as any,
    {} as any,
    {} as any,
    { findFirst: opts.tenantFindFirst } as any,
    { get: vi.fn(() => null), set: vi.fn() } as any,
    { issueTicket: vi.fn(), consumeTicket: vi.fn() } as any,
    { revoke: vi.fn(), isRevoked: vi.fn() } as any,
    { getSecretSync: vi.fn(() => 'test-secret-key-for-unit-tests') } as any,
    { consume: vi.fn(), revokeFamily: vi.fn(), issue: vi.fn() } as any,
    {} as any,
    emitter as any,
    {} as any,
    { lookup: vi.fn().mockResolvedValue(null) } as any,
    {} as never,
  );
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  (controller as unknown as { logger: typeof logger }).logger = logger;
  return { controller, emitter, logger, userRoleAssignmentService };
}

const failureReasons = (emitter: { emit: ReturnType<typeof vi.fn> }) =>
  emitter.emit.mock.calls.filter((c) => c[0] === EventTypes.UserAuthenticationFailed).map((c) => c[1].reason);

const login = (tenantKey: string) => ({ username: 'homeo_doc', password: 'secret', tenantKey }) as any;

describe('login tenant resolution (BUG-024)', () => {
  it('an unknown tenant key is 400 "Invalid or disabled tenant", not 401 "Authentication failed"', async () => {
    const { controller, emitter } = build({ tenantFindFirst: vi.fn().mockRejectedValue(new DataNotFoundException('Tenant', 'nope')) });

    const attempt = controller.login(login('nope'), request);
    await expect(attempt).rejects.toThrow(BadRequestException);
    await expect(controller.login(login('nope'), request)).rejects.toThrow('Invalid or disabled tenant');
    expect(failureReasons(emitter)).toContain('tenant_not_found');
  });

  it('the same 400 for a super admin who names an unknown tenant', async () => {
    const { controller } = build({ tenantFindFirst: vi.fn().mockRejectedValue(new DataNotFoundException('Tenant', 'nope')), roles: ['SUPER_ADMIN'] });
    await expect(controller.login(login('nope'), request)).rejects.toThrow(BadRequestException);
  });

  it('a repository outage during tenant resolution is 503 and logged, not a misleading 401', async () => {
    const outage = new Error('ECONNREFUSED postgres');
    const { controller, emitter, logger } = build({ tenantFindFirst: vi.fn().mockRejectedValue(outage) });

    await expect(controller.login(login('homeo-clinic'), request)).rejects.toThrow(ServiceUnavailableException);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: outage }));
    expect(failureReasons(emitter)).toEqual(['tenant_lookup_failed']);
  });

  it('a tenant ID (UUID) resolves by id; membership is still enforced', async () => {
    const tenantFindFirst = vi.fn(async () => ({ id: TENANT_ID, key: 'homeo-clinic' }));
    const { controller, userRoleAssignmentService } = build({ tenantFindFirst });

    // No role assignment in the tenant ⇒ the existing membership 401, proving resolution succeeded.
    await expect(controller.login(login(TENANT_ID), request)).rejects.toThrow(UnauthorizedException);
    expect(tenantFindFirst.mock.calls[0][0].filters).toMatchObject({ id: TENANT_ID });
    expect(tenantFindFirst.mock.calls[0][0].filters).not.toHaveProperty('key');
    expect(userRoleAssignmentService.findActiveAssignmentForUserInTenant).toHaveBeenCalledWith('user-1', TENANT_ID);
  });

  it('a tenant key still resolves by key', async () => {
    const tenantFindFirst = vi.fn(async () => ({ id: TENANT_ID, key: 'homeo-clinic' }));
    const { controller } = build({ tenantFindFirst });

    await expect(controller.login(login('homeo-clinic'), request)).rejects.toThrow(UnauthorizedException);
    expect(tenantFindFirst.mock.calls[0][0].filters).toMatchObject({ key: 'homeo-clinic' });
  });
});
