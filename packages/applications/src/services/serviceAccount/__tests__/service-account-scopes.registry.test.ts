/**
 * TASK-762 — the `svc:*` scope namespace.
 *
 * The whole point of the third credential class is that it shares NO mechanism
 * with tenant API keys. The scope namespace is where that is most easily eroded
 * by accident, so it gets its own suite:
 *
 *  - `svc:*` is a SEPARATE registry, not extra rows in `API_KEY_SCOPE_REGISTRY`.
 *    A tenant API key must never be mintable with a `svc:*` scope, and a service
 *    account must never carry an `admin:*` one.
 *  - Coverage is DERIVED from the admin scope vocabulary rather than
 *    hand-maintained, which is what makes boot-audit assertion D (§5.7) — every
 *    `svc:*` scope maps to a live admin area and vice-versa — mechanically true
 *    instead of aspirational.
 */
import { describe, it, expect } from 'vitest';
import { API_KEY_SCOPE_REGISTRY, isValidScope } from '../../apiKey/apikey-scopes.registry';
import {
  SERVICE_ACCOUNT_SCOPE_REGISTRY,
  STANDALONE_FEATURE_SCOPE_SOURCES,
  STANDALONE_FEATURE_SVC_SCOPES,
  SVC_SCOPE_PREFIX,
  hasServiceAccountScope,
  isValidServiceAccountScope,
  resolveServiceAccountImpliedPermissions,
  serviceAccountPolicyRules,
  toServiceAccountScope,
} from '../service-account-scopes.registry';

describe('SERVICE_ACCOUNT_SCOPE_REGISTRY', () => {
  it('contains only svc:-prefixed scopes', () => {
    for (const scope of Object.keys(SERVICE_ACCOUNT_SCOPE_REGISTRY)) {
      expect(scope.startsWith(SVC_SCOPE_PREFIX), `${scope} must be svc:-prefixed`).toBe(true);
    }
  });

  it('covers every admin:* scope of the API-key registry exactly once (boot audit D)', () => {
    const adminScopes = Object.keys(API_KEY_SCOPE_REGISTRY).filter((s) => s.startsWith('admin:') && !s.endsWith(':*'));
    for (const adminScope of adminScopes) {
      expect(SERVICE_ACCOUNT_SCOPE_REGISTRY[toServiceAccountScope(adminScope)], `no svc:* scope covers ${adminScope}`).toBeDefined();
    }
    // …and nothing beyond them, apart from the two wildcards and the TASK-767
    // standalone-feature family.
    const nonWildcard = Object.keys(SERVICE_ACCOUNT_SCOPE_REGISTRY).filter((s) => !s.endsWith(':*'));
    expect(nonWildcard.length).toBe(adminScopes.length + STANDALONE_FEATURE_SVC_SCOPES.length);
  });

  it('every non-wildcard scope declares at least one implied permission (no fail-open ceiling)', () => {
    for (const [scope, def] of Object.entries(SERVICE_ACCOUNT_SCOPE_REGISTRY)) {
      if (scope.endsWith(':*')) continue;
      expect(def.implies.length, `${scope} must declare its implied ability`).toBeGreaterThan(0);
    }
  });

  it('is DISJOINT from the API-key registry in both directions', () => {
    for (const scope of Object.keys(SERVICE_ACCOUNT_SCOPE_REGISTRY)) {
      expect(isValidScope(scope), `${scope} must NOT be a valid API-key scope`).toBe(false);
    }
    for (const scope of Object.keys(API_KEY_SCOPE_REGISTRY)) {
      expect(isValidServiceAccountScope(scope), `${scope} must NOT be a valid service-account scope`).toBe(false);
    }
  });
});

/**
 * TASK-767 — the trap TASK-766 §"Coordination note" names, pinned.
 *
 * `hasServiceAccountScope` is pure string matching, so a scope string that is
 * REGISTERED but wired to no ability still satisfies `enforceServiceAccountScopes`
 * — and then `serviceAccountPolicyRules` skips it, so CASL denies any route that
 * declares a permission pair. That combination (guard says yes, abilities say no)
 * is the worst failure mode to debug, so BOTH halves are asserted here for every
 * scope in the registry, and again at boot by `auditSvcScopeCoverage`.
 */
describe('every registered svc: scope is wired on BOTH halves (TASK-767)', () => {
  const everyScope = Object.keys(SERVICE_ACCOUNT_SCOPE_REGISTRY);

  it.each(everyScope)('%s resolves to at least one ability', (scope) => {
    expect(resolveServiceAccountImpliedPermissions(scope).length, `${scope} passes the scope guard but grants nothing`).toBeGreaterThan(0);
  });

  it.each(everyScope)('%s produces at least one CASL rule', (scope) => {
    expect(serviceAccountPolicyRules([scope]).length, `${scope} is silently skipped by serviceAccountPolicyRules`).toBeGreaterThan(0);
  });

  it('the two halves agree — nothing the guard accepts is dropped by the rule builder', () => {
    for (const scope of everyScope) {
      const implied = resolveServiceAccountImpliedPermissions(scope)
        .map((p) => `${p.action}:${p.subject}`)
        .sort();
      const rules = serviceAccountPolicyRules([scope])
        .map((r) => `${r.action}:${r.subject}`)
        .sort();
      expect(rules, `${scope} implies ${implied.join(', ')} but builds rules ${rules.join(', ')}`).toEqual(implied);
    }
  });
});

/**
 * TASK-767 — the standalone STT + summarization family.
 *
 * It is DERIVED from `API_KEY_SCOPE_REGISTRY` for the same reason the admin
 * family is: the `implies` must be the one the API-key path already uses on the
 * SAME route, or the two credential classes would silently diverge on what the
 * identical capability grants.
 */
describe('STANDALONE_FEATURE_SVC_SCOPES (TASK-767)', () => {
  it('every declared source is a real API-key scope', () => {
    for (const source of STANDALONE_FEATURE_SCOPE_SOURCES) {
      expect(API_KEY_SCOPE_REGISTRY[source], `${source} is not an API-key scope`).toBeDefined();
    }
  });

  it('each one is registered and implies EXACTLY what its API-key source implies', () => {
    for (const source of STANDALONE_FEATURE_SCOPE_SOURCES) {
      const svcScope = toServiceAccountScope(source);
      expect(isValidServiceAccountScope(svcScope), `${svcScope} must be a registry member`).toBe(true);
      expect(resolveServiceAccountImpliedPermissions(svcScope)).toEqual(API_KEY_SCOPE_REGISTRY[source]!.implies);
    }
  });

  it('carries no admin: segment — it is the BUSINESS plane, and svc:admin:* must not expand into it', () => {
    for (const svcScope of STANDALONE_FEATURE_SVC_SCOPES) {
      expect(svcScope.startsWith('svc:admin:')).toBe(false);
      expect(hasServiceAccountScope(['svc:admin:*'], svcScope), `svc:admin:* must not reach ${svcScope}`).toBe(false);
    }
  });

  it('svc:* DOES reach them — the unrestricted platform wildcard is unrestricted', () => {
    for (const svcScope of STANDALONE_FEATURE_SVC_SCOPES) {
      expect(hasServiceAccountScope(['svc:*'], svcScope)).toBe(true);
    }
  });

  it('holding one standalone scope never reaches another feature', () => {
    expect(hasServiceAccountScope(['svc:stt:stream:write'], 'svc:consultation:report:write')).toBe(false);
    expect(hasServiceAccountScope(['svc:consultation:report:write'], 'svc:stt:transcription:write')).toBe(false);
    expect(hasServiceAccountScope(['svc:stt:transcription:write'], 'svc:admin:user:write')).toBe(false);
  });
});

describe('isValidServiceAccountScope', () => {
  it('accepts registry members and the two wildcards', () => {
    expect(isValidServiceAccountScope('svc:*')).toBe(true);
    expect(isValidServiceAccountScope('svc:admin:*')).toBe(true);
    expect(isValidServiceAccountScope('svc:admin:department:manage')).toBe(true);
  });

  it('rejects the API-key admin vocabulary and the bare API-key wildcard', () => {
    expect(isValidServiceAccountScope('admin:department:manage')).toBe(false);
    expect(isValidServiceAccountScope('admin:*')).toBe(false);
    expect(isValidServiceAccountScope('*')).toBe(false);
  });

  it('rejects an unknown svc: string rather than treating it as unconstrained', () => {
    expect(isValidServiceAccountScope('svc:admin:not-a-real-area')).toBe(false);
  });
});

describe('resolveServiceAccountImpliedPermissions', () => {
  it('mirrors the implied ability of the admin scope it renamespaces', () => {
    const svc = resolveServiceAccountImpliedPermissions('svc:admin:department:manage');
    expect(svc).toEqual(API_KEY_SCOPE_REGISTRY['admin:department:manage'].implies);
  });

  it('expands svc:* to the union of every concrete scope', () => {
    const all = resolveServiceAccountImpliedPermissions('svc:*');
    expect(all.length).toBeGreaterThan(1);
    expect(all).toContainEqual({ action: 'manage', subject: 'Department' });
  });

  it('throws on an unknown scope — fail closed, so a typo can never bypass the ceiling', () => {
    expect(() => resolveServiceAccountImpliedPermissions('svc:nope')).toThrow(/Unknown service-account scope/);
    expect(() => resolveServiceAccountImpliedPermissions('admin:department:manage')).toThrow(/Unknown service-account scope/);
  });
});

describe('hasServiceAccountScope', () => {
  it('matches exactly, by parent prefix, and by trailing wildcard', () => {
    expect(hasServiceAccountScope(['svc:admin:department:manage'], 'svc:admin:department:manage')).toBe(true);
    expect(hasServiceAccountScope(['svc:admin:*'], 'svc:admin:department:manage')).toBe(true);
    expect(hasServiceAccountScope(['svc:*'], 'svc:admin:department:manage')).toBe(true);
  });

  it('never lets an svc wildcard reach outside the svc namespace', () => {
    expect(hasServiceAccountScope(['svc:*'], 'admin:department:manage')).toBe(false);
    expect(hasServiceAccountScope(['svc:*'], 'stt:transcription:read')).toBe(false);
  });

  it('does not honour the bare API-key `*` wildcard', () => {
    // A service account can never hold `'*'` (the entity rejects it), but the
    // matcher must not treat one as universal even if a row were corrupted.
    expect(hasServiceAccountScope(['*'], 'svc:admin:department:manage')).toBe(false);
  });

  it('refuses an empty scope set', () => {
    expect(hasServiceAccountScope([], 'svc:admin:department:manage')).toBe(false);
    expect(hasServiceAccountScope(null, 'svc:admin:department:manage')).toBe(false);
  });

  it('does not let a prefix match cross a namespace boundary', () => {
    expect(hasServiceAccountScope(['svc:admin:department:*'], 'svc:admin:departmentagent:manage')).toBe(false);
  });
});
