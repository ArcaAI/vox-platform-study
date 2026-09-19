/**
 * TASK-993 lane J, item 2 — which address `UnifiedAuthGuard` attributes an
 * authentication attempt to.
 *
 * The address reaches `ApiKeyService.authenticateByRawKey` (and the
 * service-account validator), which stamps it onto the credential's usage
 * record and into the audit trail. It was read from `X-Forwarded-For`, which
 * behind this platform's ingress (`Cloudflare edge → cloudflared → Traefik →
 * pod`) names the CLOUDFLARED POD, so every audited action on a PHI platform
 * was attributed to a piece of infrastructure. Off that ingress the header is
 * simply whatever the caller typed, so a direct caller chose the address
 * recorded against its own key.
 *
 * The rule is now lane A's, shared with the rate limiter's bucket key:
 * `CF-Connecting-IP` is believed only when the SOCKET PEER is a declared
 * ingress; otherwise the socket peer itself is recorded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PolicyEngine } from '../policy.engine';
import { API_KEY_REQUIRED_SCOPES, UnifiedAuthGuard } from '../unified-auth.guard';

const KEY_ENTITY = {
  id: 'key-1',
  keyName: 'test-key',
  tenantId: 'tenant-1',
  userId: 'user-api-1',
  scopes: ['read:data'],
  rateLimit: 0,
  allowedIps: [],
};

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method: 'GET', url: '/test', params: {}, ...request }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

let apiKeyService: { extractApiKeyFromRequest: ReturnType<typeof vi.fn>; authenticateByRawKey: ReturnType<typeof vi.fn>; hasScope: ReturnType<typeof vi.fn> };
let guard: UnifiedAuthGuard;

const original = process.env.RATE_LIMIT_TRUSTED_PROXIES;

beforeEach(() => {
  delete process.env.RATE_LIMIT_TRUSTED_PROXIES;
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => (key === API_KEY_REQUIRED_SCOPES ? ['read:data'] : undefined)),
  } as unknown as Reflector;
  apiKeyService = {
    extractApiKeyFromRequest: vi.fn().mockReturnValue('raw-key-123'),
    authenticateByRawKey: vi.fn().mockResolvedValue(KEY_ENTITY),
    hasScope: vi.fn().mockReturnValue(true),
  };
  guard = new UnifiedAuthGuard(
    reflector,
    apiKeyService as never,
    { buildAbility: vi.fn() } as unknown as PolicyEngine,
    { get: vi.fn().mockReturnValue(undefined), set: vi.fn() } as never,
    { checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10, resetAt: new Date() }) } as never,
    { canActivate: vi.fn().mockResolvedValue(true) } as never,
  );
});

afterEach(() => {
  if (original === undefined) delete process.env.RATE_LIMIT_TRUSTED_PROXIES;
  else process.env.RATE_LIMIT_TRUSTED_PROXIES = original;
});

/** The address the guard handed to the API-key authenticator. */
async function auditedIp(request: Record<string, unknown>): Promise<string> {
  await guard.canActivate(contextFor(request));
  return apiKeyService.authenticateByRawKey.mock.calls[0]![1] as string;
}

describe('UnifiedAuthGuard — the audited client address', () => {
  it('IGNORES X-Forwarded-For and records the socket peer', async () => {
    expect(
      await auditedIp({
        headers: { 'x-forwarded-for': '203.0.113.50, 70.41.3.18' },
        socket: { remoteAddress: '10.42.0.7' },
        ip: '10.42.0.7',
      }),
    ).toBe('10.42.0.7');
  });

  it('IGNORES CF-Connecting-IP from a peer that is not a declared ingress', async () => {
    expect(
      await auditedIp({
        headers: { 'cf-connecting-ip': '198.51.100.9' },
        socket: { remoteAddress: '203.0.113.200' },
        ip: '203.0.113.200',
      }),
    ).toBe('203.0.113.200');
  });

  it('records CF-Connecting-IP when the SOCKET PEER is a declared ingress', async () => {
    process.env.RATE_LIMIT_TRUSTED_PROXIES = '10.42.0.0/16';
    expect(
      await auditedIp({
        headers: { 'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '203.0.113.50' },
        socket: { remoteAddress: '10.42.0.7' },
        ip: '10.42.0.7',
      }),
    ).toBe('198.51.100.9');
  });

  it('folds an IPv4-mapped IPv6 peer so a dual-stack socket still matches a v4 block', async () => {
    process.env.RATE_LIMIT_TRUSTED_PROXIES = '10.42.0.0/16';
    expect(
      await auditedIp({
        headers: { 'cf-connecting-ip': '198.51.100.9' },
        socket: { remoteAddress: '::ffff:10.42.0.7' },
      }),
    ).toBe('198.51.100.9');
  });

  it('reads the SOCKET peer for the trust check, never the (spoofable) req.ip', async () => {
    process.env.RATE_LIMIT_TRUSTED_PROXIES = '10.42.0.0/16';
    expect(
      await auditedIp({
        headers: { 'cf-connecting-ip': '198.51.100.9' },
        socket: { remoteAddress: '203.0.113.200' },
        ip: '10.42.0.7',
      }),
    ).toBe('203.0.113.200');
  });

  it('refuses a claimed value that is not an address, rather than auditing junk', async () => {
    process.env.RATE_LIMIT_TRUSTED_PROXIES = '10.42.0.0/16';
    expect(
      await auditedIp({
        headers: { 'cf-connecting-ip': 'not-an-ip' },
        socket: { remoteAddress: '10.42.0.7' },
      }),
    ).toBe('10.42.0.7');
  });

  it('still records "unknown" when the request carries no address at all', async () => {
    expect(await auditedIp({ headers: {} })).toBe('unknown');
  });
});
