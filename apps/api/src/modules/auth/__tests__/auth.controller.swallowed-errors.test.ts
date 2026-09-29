/**
 * AuthController — an infrastructure failure must not read as "not found".
 *
 * Before: the login and refresh user lookups, the logout revocations and the
 * stream-ticket ownership lookups each had a bare `catch {}` that turned a
 * database / Redis outage into "unknown user" / "disabled account" / a silent
 * success. Now a genuine miss keeps its old answer (and the client-visible 401
 * stays identical, so there is still no account oracle) while an outage is
 * logged with the Error object and surfaces as an outage.
 */
import { DataNotFoundException } from '@arcaai/exceptions';
import { describe, it, expect, vi } from 'vitest';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { EventTypes } from '@arcaai/domains';
import { AuthController } from '../auth.controller';

const request = { ip: '203.0.113.7', headers: { 'user-agent': 'test-agent' } };

function build(overrides: Record<string, any> = {}) {
  const emitter = { emit: vi.fn() };
  const jwtRevocationService = overrides.jwtRevocationService ?? { revoke: vi.fn().mockResolvedValue(undefined), isRevoked: vi.fn() };
  const refreshTokenService = overrides.refreshTokenService ?? { consume: vi.fn(), revokeFamily: vi.fn().mockResolvedValue(undefined), issue: vi.fn() };
  const authService = overrides.authService ?? { trackAuthentication: vi.fn().mockResolvedValue(undefined) };
  const controller = new AuthController(
    {} as any,
    authService,
    { getValueWithDefault: vi.fn((_k: string, d: string) => d) } as any,
    {} as any,
    (overrides.userRepository ?? {}) as any,
    {} as any,
    {} as any,
    { findFirst: vi.fn(async () => ({ id: 'tenant-A', key: 'k', resourceStatus: 'ENABLED' })) } as any,
    { get: vi.fn((key: string) => (key === 'user' ? overrides.clsUser : null)), set: vi.fn() } as any,
    { issueTicket: vi.fn(), consumeTicket: vi.fn() } as any,
    jwtRevocationService,
    { getSecretSync: vi.fn(() => 'test-secret-key-for-unit-tests') } as any,
    refreshTokenService,
    {} as any,
    emitter as any,
    {} as any,
    { lookup: vi.fn().mockResolvedValue(null) } as any,
    {} as never,
  );
  const logger = { warn: vi.fn(), error: vi.fn() };
  (controller as unknown as { logger: typeof logger }).logger = logger;
  return { controller, emitter, logger, jwtRevocationService, refreshTokenService, authService };
}

const failureReasons = (emitter: { emit: ReturnType<typeof vi.fn> }) =>
  emitter.emit.mock.calls.filter((c) => c[0] === EventTypes.UserAuthenticationFailed).map((c) => c[1].reason);

describe('login user lookup', () => {
  const credentials = { username: 'ghost', password: 'x', tenantKey: 'k' } as any;

  it('an unknown user is still the uniform 401 with the same audit reason', async () => {
    const { controller, emitter, logger } = build({ userRepository: { findByUsername: vi.fn().mockRejectedValue(new DataNotFoundException('User', 'ghost')) } });

    await expect(controller.login(credentials, request)).rejects.toThrow(UnauthorizedException);
    expect(failureReasons(emitter)).toEqual(['unknown_or_disabled_user']);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a database outage is logged and answered as an outage, not as "invalid credentials"', async () => {
    const outage = new Error('ECONNREFUSED postgres');
    const { controller, emitter, logger } = build({ userRepository: { findByUsername: vi.fn().mockRejectedValue(outage) } });

    await expect(controller.login(credentials, request)).rejects.toThrow(ServiceUnavailableException);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: outage }));
    expect(failureReasons(emitter)).toEqual(['user_lookup_failed']);
  });
});

describe('refresh user lookup', () => {
  const consumed = { userId: 'doctor-001', tenantId: 'tenant-A', jti: 'j', family: 'f' };

  it('a disabled or deleted account is still audited as user_disabled_or_missing', async () => {
    const { controller, emitter } = build({
      userRepository: { findFirst: vi.fn().mockRejectedValue(new DataNotFoundException('User', 'doctor-001')) },
      refreshTokenService: { consume: vi.fn(async () => consumed), revokeFamily: vi.fn(), issue: vi.fn() },
    });

    await expect(controller.refresh({ refreshToken: 'valid' } as any)).rejects.toThrow(UnauthorizedException);
    expect(failureReasons(emitter)).toEqual(['user_disabled_or_missing']);
  });

  it('an outage is logged and rethrown — a database blip must not read as a revoked account', async () => {
    const outage = new Error('ECONNRESET');
    const { controller, emitter, logger } = build({
      userRepository: { findFirst: vi.fn().mockRejectedValue(outage) },
      refreshTokenService: { consume: vi.fn(async () => consumed), revokeFamily: vi.fn(), issue: vi.fn() },
    });

    await expect(controller.refresh({ refreshToken: 'valid' } as any)).rejects.toBe(outage);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: outage, userId: 'doctor-001' }));
    expect(failureReasons(emitter)).toEqual([]);
  });
});

describe('logout (documented best-effort: the response stays a success)', () => {
  it('a failed token revocation is logged at error with the Error object, and the logout still succeeds', async () => {
    const outage = new Error('redis down');
    const { controller, logger } = build({
      clsUser: { id: 'user-1', jti: 'jti-1', exp: 1, refreshFamily: 'fam-1' },
      jwtRevocationService: { revoke: vi.fn().mockRejectedValue(outage), isRevoked: vi.fn() },
      refreshTokenService: { consume: vi.fn(), revokeFamily: vi.fn().mockRejectedValue(outage), issue: vi.fn() },
    });

    await expect(controller.logout(request as any)).resolves.toMatchObject({ success: true });
    const errorCalls = logger.error.mock.calls.map((c) => c[0]);
    expect(errorCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'Logout access-token revocation failed', error: outage }),
        expect.objectContaining({ message: 'Logout refresh-family revocation failed', error: outage }),
      ]),
    );
  });
});
