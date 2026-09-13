import { describe, expect, it } from 'vitest';

import { SECURITY_SCHEME_API_KEY, SECURITY_SCHEME_BEARER, SECURITY_SCHEME_SERVICE_ACCOUNT, securityForRoute } from '../operation-security';
import type { RouteAuthorizationFacts } from '../operation-security';

/**
 * TASK-971 lane F (finding F-F2) — the pure half of the fix.
 *
 * `securityForRoute` is the ONE place the gateway decides which credential
 * classes an operation advertises. It mirrors `UnifiedAuthGuard`, and the four
 * invariants of `.claude/rules/05-nestjs-api.md` §API Test Standard are asserted
 * here literally, because a wrong answer here is published to every developer
 * who reads the reference:
 *
 *  - `@ForbidApiKey()` / `@ForbidServiceAccount()` are checked BEFORE scopes, so
 *    the refusal is unconditional — a broadly-scoped credential does not help.
 *  - No scope declaration = deny-by-default for BOTH machine classes. Absent is
 *    a 403 expectation, not "unknown".
 *  - A `@Public()` route needs no credential at all, whatever else it declares.
 *  - Every non-public route is reachable with a user JWT: there is no
 *    `@ForbidJwt`, and the deny-by-default boot audit refuses to start a gateway
 *    with a route carrying neither `@Public()` nor a permission decorator.
 */

const NOTHING_DECLARED: RouteAuthorizationFacts = {
  isPublic: false,
  apiKeyForbidden: false,
  apiKeyScopes: [],
  forbidServiceAccount: false,
  svcScopes: [],
};

describe('securityForRoute', () => {
  it('publishes no security requirement for a @Public() route', () => {
    expect(securityForRoute({ ...NOTHING_DECLARED, isPublic: true })).toBeUndefined();
  });

  it('keeps a @Public() route credential-free even when scopes are declared on it', () => {
    expect(
      securityForRoute({
        ...NOTHING_DECLARED,
        isPublic: true,
        apiKeyScopes: ['consultation:report:write'],
        svcScopes: ['svc:consultation:report:write'],
      }),
    ).toBeUndefined();
  });

  it('advertises the user JWT alone when no machine scope is declared', () => {
    expect(securityForRoute(NOTHING_DECLARED)).toEqual([{ [SECURITY_SCHEME_BEARER]: [] }]);
  });

  it('adds api-key when an API-key scope is declared', () => {
    expect(securityForRoute({ ...NOTHING_DECLARED, apiKeyScopes: ['agent:invocation:write'] })).toEqual([
      { [SECURITY_SCHEME_BEARER]: [] },
      { [SECURITY_SCHEME_API_KEY]: [] },
    ]);
  });

  it('adds service-account when a svc: scope is declared', () => {
    expect(securityForRoute({ ...NOTHING_DECLARED, svcScopes: ['svc:agent:invocation:write'] })).toEqual([
      { [SECURITY_SCHEME_BEARER]: [] },
      { [SECURITY_SCHEME_SERVICE_ACCOUNT]: [] },
    ]);
  });

  it('advertises all three classes, in the order the reference registers them', () => {
    expect(
      securityForRoute({
        ...NOTHING_DECLARED,
        apiKeyScopes: ['agent:invocation:write'],
        svcScopes: ['svc:agent:invocation:write'],
      }),
    ).toEqual([{ [SECURITY_SCHEME_BEARER]: [] }, { [SECURITY_SCHEME_API_KEY]: [] }, { [SECURITY_SCHEME_SERVICE_ACCOUNT]: [] }]);
  });

  it('drops api-key when @ForbidApiKey() is set, however broadly scoped', () => {
    expect(
      securityForRoute({
        ...NOTHING_DECLARED,
        apiKeyForbidden: true,
        apiKeyScopes: ['admin:all'],
      }),
    ).toEqual([{ [SECURITY_SCHEME_BEARER]: [] }]);
  });

  it('drops service-account when @ForbidServiceAccount() is set, however broadly scoped', () => {
    expect(
      securityForRoute({
        ...NOTHING_DECLARED,
        forbidServiceAccount: true,
        svcScopes: ['svc:admin:settings:manage'],
      }),
    ).toEqual([{ [SECURITY_SCHEME_BEARER]: [] }]);
  });

  it('never repeats a scheme', () => {
    const security = securityForRoute({
      ...NOTHING_DECLARED,
      apiKeyScopes: ['a:b:c', 'd:e:f'],
      svcScopes: ['svc:a:b:c', 'svc:d:e:f'],
    });

    const names = (security ?? []).flatMap((requirement) => Object.keys(requirement));
    expect(names).toEqual([...new Set(names)]);
  });

  it('emits EMPTY scope arrays — the OpenAPI spec forbids listing scopes for http/apiKey schemes', () => {
    const security = securityForRoute({
      ...NOTHING_DECLARED,
      apiKeyScopes: ['agent:invocation:write'],
      svcScopes: ['svc:agent:invocation:write'],
    });

    for (const requirement of security ?? []) {
      for (const value of Object.values(requirement)) {
        expect(value).toEqual([]);
      }
    }
  });
});
