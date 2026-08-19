/**
 * H-01 — a JWT must never authenticate via a URL query parameter.
 *
 * `UnifiedAuthGuard` used to rewrite `?token=<value>` into an
 * `Authorization: Bearer <value>` header for EVERY route:
 *
 *   // SSE set token in query param
 *   if (!request.headers?.authorization && request.query?.token) { ... }
 *
 * The comment said "SSE", but the code was gated on nothing — not
 * `SSE_METADATA`, not `@StreamScope`, not the path — so a long-lived session
 * JWT appended to ANY of the gateway's routes authenticated successfully.
 * That is precisely what the single-use stream-ticket subsystem
 * (`apps/api/src/modules/auth/stream-ticket.service.ts`) exists to prevent:
 * query strings land in CDN access logs, browser history, `Referer` headers
 * and session-replay recordings, which is HIPAA-relevant here.
 *
 * The rewrite is DELETED. The supported browser-`EventSource` path is
 * `?ticket=<single-use ticket>`, scope-checked in
 * `apps/api/src/guards/jwtauth.guard.ts`, and it is untouched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnifiedAuthGuard } from '../unified-auth.guard';
import { Authorize } from '../decorators';

class DummyController {
  @Authorize()
  ordinaryRoute() {}
}

const createMockContext = (query: Record<string, unknown>, headers: Record<string, unknown> = {}) => {
  const request = {
    headers,
    query,
    method: 'GET',
    url: '/api/v1/auth/me',
    ip: '127.0.0.1',
    params: {},
  } as Record<string, unknown>;
  return {
    request,
    ctx: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => DummyController.prototype.ordinaryRoute,
      getClass: () => DummyController,
    } as unknown as ExecutionContext,
  };
};

describe('UnifiedAuthGuard — no JWT-in-URL credential path (H-01)', () => {
  let guard: UnifiedAuthGuard;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- hand-rolled doubles; matches this folder's style.
  let jwtAuthGuard: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let apiKeyService: any;

  beforeEach(() => {
    apiKeyService = { extractApiKeyFromRequest: () => undefined, authenticateByRawKey: vi.fn(), hasScope: () => false };
    // Stands in for the real JWT guard: succeeds only when a Bearer header is present.
    jwtAuthGuard = {
      canActivate: vi.fn(async (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest();
        return Boolean(req.headers?.authorization);
      }),
    };
    const policyEngine = { buildAbility: vi.fn(async () => ({ can: () => true })) };
    const clsService = { get: vi.fn(() => undefined), set: vi.fn() };
    guard = new UnifiedAuthGuard(new Reflector(), apiKeyService, policyEngine as never, clsService as never, undefined, jwtAuthGuard);
  });

  it('REJECTS a request whose only credential is ?token=<jwt>', async () => {
    const { ctx } = createMockContext({ token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEifQ.sig' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(/Authentication required/);
  });

  it('never rewrites ?token= into an Authorization header', async () => {
    const { ctx, request } = createMockContext({ token: 'any-value-at-all' });
    await expect(guard.canActivate(ctx)).rejects.toThrow();
    expect((request.headers as Record<string, unknown>).authorization).toBeUndefined();
  });

  it('still authenticates via the Authorization header (unaffected)', async () => {
    const { ctx } = createMockContext({}, { authorization: 'Bearer real.jwt.here' });
    await expect(guard.canActivate(ctx)).resolves.toBeTruthy();
  });

  it('leaves ?ticket= alone — the JWT guard still sees it and decides', async () => {
    const { ctx, request } = createMockContext({ ticket: 'st_singleuse_abc' });
    // The stand-in guard has no ticket support, so this 401s here; what matters
    // is that the guard delegated with the query intact and added no header.
    await expect(guard.canActivate(ctx)).rejects.toThrow();
    expect(jwtAuthGuard.canActivate).toHaveBeenCalled();
    expect((request.query as Record<string, unknown>).ticket).toBe('st_singleuse_abc');
    expect((request.headers as Record<string, unknown>).authorization).toBeUndefined();
  });
});
