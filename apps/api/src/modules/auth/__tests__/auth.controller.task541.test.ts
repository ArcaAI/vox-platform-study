/**
 * AuthController — failed-authentication audit trail.
 *
 * Gap closed: `EventTypes.UserAuthenticated` is a SUCCESS-ONLY bracket, so a
 * rejected login/refresh produced structured warn logs and nothing queryable.
 * HIPAA §164.312(b) access auditing expects rejected access to be reviewable.
 *
 * Contract pinned here:
 *   - every login rejection emits exactly ONE
 *     `EventTypes.UserAuthenticationFailed` carrying a machine-readable
 *     `reason` slug, the attempted username, and request provenance;
 *   - the 401 RESPONSE stays uniform across unknown-user vs bad-password (no
 *     account oracle) even though the two audit rows differ;
 *   - the attempted PASSWORD never reaches the event payload;
 *   - refresh-token miss/reuse and disabled-account refresh are audited;
 *   - a SUCCESSFUL login emits no failure event;
 *   - an audit-emitter fault never changes the HTTP outcome.
 *
 * Mirrors the auth.controller.task307.test.ts harness shape.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { EventTypes } from '@arcaai/domains';
import { AuthController } from '../auth.controller';

const JWT_TEST_SECRET = 'test-secret-key-for-unit-tests';

const createMockClsService = () => ({ get: vi.fn(() => null), set: vi.fn() });

const createUser = (overrides: Record<string, any> = {}) => ({
  id: 'doctor-001',
  username: 'dr_smith',
  password: '$2a$10$placeholder',
  tenantId: 'tenant-A',
  UserProfile: { email: 'smith@hospital.com' },
  resourceStatus: 'ENABLED',
  isServiceAccount: false,
  lastLoginAt: null,
  lastActiveAt: null,
  ...overrides,
});

/**
 * The REAL `Repository.findFirst` throws `DataNotFoundException` on a miss —
 * it never resolves to null (packages/domains/src/common/repository.ts:117).
 * An earlier version of this double resolved null, which made the
 * unknown-username path look reachable in tests while production actually fell
 * through to the catch-all with the wrong reason AND a different 401 message.
 * The double now mirrors the throwing contract.
 */
const createMockUserRepository = (user: any = null) => ({
  findFirst: vi.fn(async () => {
    if (!user) throw new Error('DataNotFoundException: User not found');
    return user;
  }),
  update: vi.fn(),
});

const createMockTenantRepository = (tenant: any = { id: 'tenant-A', key: 'tenant-a-key', resourceStatus: 'ENABLED' }) => ({
  findFirst: vi.fn(async () => tenant),
});

const createMockUraService = (tenantAssignment: any = { id: 'ura-1' }) => ({
  findActiveRolesForUser: vi.fn(async () => [{ id: 'role-doctor', name: 'doctor', permissions: ['read:consultation'] }]),
  findActiveAssignmentForUserInTenant: vi.fn(async () => tenantAssignment),
  findActiveTenantIdsForUser: vi.fn(async () => []),
});

const createMockAppSettings = () => ({
  getValueWithDefault: vi.fn((key: string, defaultVal: string) => {
    if (key === 'JWT_EXPIRES_IN') return '1h';
    return defaultVal;
  }),
});

const createMockSecretsService = () => ({
  getSecretSync: vi.fn((key: string) => (key === 'JWT_SECRET_KEY' ? JWT_TEST_SECRET : undefined)),
});

const createMockRefreshTokenService = () => ({
  issue: vi.fn(async ({ jti, family }: any) => ({
    rawToken: `opaque-${jti}`,
    family: family ?? `family-for-${jti}`,
    expiresAt: Math.floor(Date.now() / 1000) + 604800,
  })),
  consume: vi.fn(),
  revokeFamily: vi.fn().mockResolvedValue(undefined),
});

const createMockRequest = () => ({ ip: '203.0.113.7', headers: { 'user-agent': 'test-agent' } });

function buildController(overrides: any = {}) {
  const emitter = overrides.eventEmitter ?? { emit: vi.fn() };
  const controller = new AuthController(
    {} as any,
    (overrides.authService ?? { trackAuthentication: vi.fn().mockResolvedValue(undefined) }) as any,
    (overrides.appSettingsService ?? createMockAppSettings()) as any,
    (overrides.userRoleAssignmentService ?? createMockUraService()) as any,
    (overrides.userRepository ?? createMockUserRepository()) as any,
    {} as any,
    {} as any,
    (overrides.tenantRepository ?? createMockTenantRepository()) as any,
    (overrides.clsService ?? createMockClsService()) as any,
    { issueTicket: vi.fn(), consumeTicket: vi.fn() } as any,
    { revoke: vi.fn().mockResolvedValue(undefined), isRevoked: vi.fn().mockResolvedValue(false) } as any,
    (overrides.secretsService ?? createMockSecretsService()) as any,
    (overrides.refreshTokenService ?? createMockRefreshTokenService()) as any,
    { findActiveDepartmentForUserInTenant: vi.fn(async () => ({ id: 'ud-1' })) } as any,
    emitter as any,
    {} as any,
    { lookup: vi.fn().mockResolvedValue(null) } as any,
  );
  return { controller, emitter };
}

/** All UserAuthenticationFailed payloads emitted so far. */
function failureEvents(emitter: { emit: ReturnType<typeof vi.fn> }): any[] {
  return emitter.emit.mock.calls.filter((call) => call[0] === EventTypes.UserAuthenticationFailed).map((call) => call[1]);
}

describe('AuthController — failed-login audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('audits an unknown username with reason unknown_or_disabled_user', async () => {
    const { controller, emitter } = buildController({ userRepository: createMockUserRepository(null) });

    await expect(
      controller.login({ username: 'ghost', password: 'whatever', tenantKey: 'tenant-a-key' } as any, createMockRequest()),
    ).rejects.toThrow(UnauthorizedException);

    const events = failureEvents(emitter);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: 'unknown_or_disabled_user',
      attemptedUsername: 'ghost',
      endpoint: '/auth/login',
      method: 'POST',
      ip: '203.0.113.7',
      userAgent: 'test-agent',
    });
    // No account resolved ⇒ no userId to attribute the row to.
    expect(events[0].userId).toBeUndefined();
  });

  it('audits a wrong password with reason invalid_password AND the resolved userId', async () => {
    const user = createUser({ password: await bcrypt.hash('correct-password', 10) });
    const { controller, emitter } = buildController({ userRepository: createMockUserRepository(user) });

    await expect(
      controller.login({ username: 'dr_smith', password: 'wrong-password', tenantKey: 'tenant-a-key' } as any, createMockRequest()),
    ).rejects.toThrow(UnauthorizedException);

    const events = failureEvents(emitter);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'invalid_password', userId: 'doctor-001', attemptedUsername: 'dr_smith' });
  });

  // Regression guard: previously the unknown-username path reached the
  // catch-all ('Authentication failed') while a wrong password answered
  // 'Invalid credentials' — a username-enumeration oracle. This only
  // reproduces with a THROWING repository double, matching production.
  it('keeps the 401 response uniform across unknown-user and bad-password (no account oracle)', async () => {
    const { controller: unknownCtl } = buildController({ userRepository: createMockUserRepository(null) });
    const user = createUser({ password: await bcrypt.hash('correct-password', 10) });
    const { controller: badPwCtl } = buildController({ userRepository: createMockUserRepository(user) });

    const unknownErr = await unknownCtl
      .login({ username: 'ghost', password: 'x', tenantKey: 'tenant-a-key' } as any, createMockRequest())
      .catch((e) => e);
    const badPwErr = await badPwCtl
      .login({ username: 'dr_smith', password: 'x', tenantKey: 'tenant-a-key' } as any, createMockRequest())
      .catch((e) => e);

    expect(unknownErr.message).toBe(badPwErr.message);
    expect(unknownErr.getStatus()).toBe(badPwErr.getStatus());
  });

  it('NEVER carries the attempted password into the audit event', async () => {
    const user = createUser({ password: await bcrypt.hash('correct-password', 10) });
    const { controller, emitter } = buildController({ userRepository: createMockUserRepository(user) });

    await controller
      .login({ username: 'dr_smith', password: 'SuperSecret123!', tenantKey: 'tenant-a-key' } as any, createMockRequest())
      .catch(() => undefined);

    expect(JSON.stringify(failureEvents(emitter))).not.toContain('SuperSecret123!');
  });

  it('audits a service account attempting interactive login', async () => {
    const user = createUser({ password: await bcrypt.hash('pw', 10), isServiceAccount: true });
    const { controller, emitter } = buildController({ userRepository: createMockUserRepository(user) });

    await expect(controller.login({ username: 'dr_smith', password: 'pw', tenantKey: 'tenant-a-key' } as any, createMockRequest())).rejects.toThrow(
      UnauthorizedException,
    );

    expect(failureEvents(emitter)[0]).toMatchObject({ reason: 'service_account_interactive_login', userId: 'doctor-001' });
  });

  it('audits a tenant-membership rejection', async () => {
    const user = createUser({ password: await bcrypt.hash('pw', 10) });
    const { controller, emitter } = buildController({
      userRepository: createMockUserRepository(user),
      userRoleAssignmentService: createMockUraService(null),
    });

    await expect(controller.login({ username: 'dr_smith', password: 'pw', tenantKey: 'tenant-a-key' } as any, createMockRequest())).rejects.toThrow(
      UnauthorizedException,
    );

    expect(failureEvents(emitter)[0]).toMatchObject({ reason: 'tenant_access_denied', tenantKey: 'tenant-a-key' });
  });

  it('audits a malformed request with reason missing_credentials', async () => {
    const { controller, emitter } = buildController();

    await controller.login({ username: '', password: '' } as any, createMockRequest()).catch(() => undefined);

    expect(failureEvents(emitter)[0]).toMatchObject({ reason: 'missing_credentials' });
  });

  it('emits NO failure event on a successful login', async () => {
    const user = createUser({ password: await bcrypt.hash('pw', 10) });
    const { controller, emitter } = buildController({ userRepository: createMockUserRepository(user) });

    const result = await controller.login({ username: 'dr_smith', password: 'pw', tenantKey: 'tenant-a-key' } as any, createMockRequest());

    expect(result.token).toBeDefined();
    expect(failureEvents(emitter)).toHaveLength(0);
  });

  it('an audit-emitter fault never changes the HTTP outcome', async () => {
    const throwingEmitter = {
      emit: vi.fn(() => {
        throw new Error('event bus down');
      }),
    };
    const { controller } = buildController({ userRepository: createMockUserRepository(null), eventEmitter: throwingEmitter });

    // Still a 401 — not a 500 from the audit path.
    await expect(controller.login({ username: 'ghost', password: 'x', tenantKey: 'tenant-a-key' } as any, createMockRequest())).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('AuthController — failed-refresh audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('audits a rejected refresh token (miss or reuse — the token-theft signal)', async () => {
    const refreshTokenService = createMockRefreshTokenService();
    refreshTokenService.consume = vi.fn(async () => {
      throw new UnauthorizedException('Invalid refresh token');
    });
    const { controller, emitter } = buildController({ refreshTokenService });

    await expect(controller.refresh({ refreshToken: 'stolen-token' } as any)).rejects.toThrow(UnauthorizedException);

    expect(failureEvents(emitter)[0]).toMatchObject({ reason: 'refresh_token_rejected', endpoint: '/auth/refresh' });
  });

  it('audits a valid refresh token whose account has since been disabled', async () => {
    const refreshTokenService = createMockRefreshTokenService();
    refreshTokenService.consume = vi.fn(async () => ({
      userId: 'doctor-001',
      tenantId: 'tenant-A',
      jti: 'old-jti',
      family: 'family-1',
    }));
    const { controller, emitter } = buildController({
      refreshTokenService,
      userRepository: createMockUserRepository(null),
    });

    await expect(controller.refresh({ refreshToken: 'valid-token' } as any)).rejects.toThrow(UnauthorizedException);

    expect(failureEvents(emitter)[0]).toMatchObject({ reason: 'user_disabled_or_missing', userId: 'doctor-001' });
  });

  it('emits NO failure event on a successful refresh', async () => {
    const refreshTokenService = createMockRefreshTokenService();
    refreshTokenService.consume = vi.fn(async () => ({
      userId: 'doctor-001',
      tenantId: 'tenant-A',
      jti: 'old-jti',
      family: 'family-1',
    }));
    const { controller, emitter } = buildController({
      refreshTokenService,
      userRepository: createMockUserRepository(createUser()),
    });

    const result = await controller.refresh({ refreshToken: 'valid-token' } as any);

    expect(result.token).toBeDefined();
    expect(failureEvents(emitter)).toHaveLength(0);
  });
});
