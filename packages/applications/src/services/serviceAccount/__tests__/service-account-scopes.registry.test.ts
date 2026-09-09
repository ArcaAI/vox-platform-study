/**
 * the `svc:*` scope namespace.
 *
 * The whole point of the third credential class is that it shares NO mechanism
 * with tenant API keys. The scope namespace is where that is most easily eroded
 * by accident, so it gets its own suite:
 *
 *  - `svc:*` is a SEPARATE registry, not extra rows in `API_KEY_SCOPE_REGISTRY`.
 *    A tenant API key must never be mintable with a `svc:*` scope, and a service
 *    account must never carry an `admin:*` one.
 *  - Coverage is DERIVED from the admin scope vocabulary rather than
 * hand-maintained, which is what makes boot-audit assertion D — every
 *    `svc:*` scope maps to a live admin area and vice-versa — mechanically true
 *    instead of aspirational.
 */
import { describe, it, expect } from 'vitest';
import { API_KEY_SCOPE_REGISTRY, isValidScope } from '../../apiKey/apikey-scopes.registry';
import {
  ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES,
  ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES,
  AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES,
  AGENT_WORKFLOW_BUSINESS_PLANE_SVC_SCOPES,
  CONSULTATION_REALTIME_SCOPE_SOURCES,
  CONSULTATION_REALTIME_SVC_SCOPES,
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
    // …and nothing beyond them, apart from the two wildcards, the
    // standalone-feature family and the pre-convention family.
    const nonWildcard = Object.keys(SERVICE_ACCOUNT_SCOPE_REGISTRY).filter((s) => !s.endsWith(':*'));
    expect(nonWildcard.length).toBe(
      adminScopes.length +
        STANDALONE_FEATURE_SVC_SCOPES.length +
        ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES.length +
        AGENT_WORKFLOW_BUSINESS_PLANE_SVC_SCOPES.length +
        CONSULTATION_REALTIME_SVC_SCOPES.length,
    );
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
 * the trap names, pinned.
 *
 * `hasServiceAccountScope` is pure string matching, so a scope string that is
 * REGISTERED but wired to no ability still satisfies `enforceServiceAccountScopes`
 * — and then `serviceAccountPolicyRules` skips it, so CASL denies any route that
 * declares a permission pair. That combination (guard says yes, abilities say no)
 * is the worst failure mode to debug, so BOTH halves are asserted here for every
 * scope in the registry, and again at boot by `auditSvcScopeCoverage`.
 */
describe('every registered svc: scope is wired on BOTH halves ', () => {
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
 * the standalone STT + summarization family.
 *
 * It is DERIVED from `API_KEY_SCOPE_REGISTRY` for the same reason the admin
 * family is: the `implies` must be the one the API-key path already uses on the
 * SAME route, or the two credential classes would silently diverge on what the
 * identical capability grants.
 */
describe('STANDALONE_FEATURE_SVC_SCOPES ', () => {
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

/**
 * (owner decision O-1) — the admin-plane PRE-CONVENTION family.
 *
 * `WebhookController` sits at `admin/webhooks` but is gated by
 * `webhook:event:write`, a scope minted before the `admin:<area>` convention
 * existed. The `svc:admin:*` derivation cannot see it, so opening the area to
 * machines needs its own DERIVED family — kept separate from
 * `STANDALONE_FEATURE_SCOPE_SOURCES` (business plane) so neither constant's
 * name lies about what it holds, and separate from the `svc:admin:*` prefix so
 * that wildcard's meaning does not silently widen.
 *
 * The three properties asserted here are exactly the ones that would break
 * quietly: membership, disjointness from the API-key registry, and a NON-EMPTY
 * ability resolution (the trap — a scope that passes the string guard
 * and is then refused by CASL).
 */
describe('ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES (O-1)', () => {
  it('every declared source is a real API-key scope — the family is DERIVED, never invented', () => {
    for (const source of ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES) {
      expect(API_KEY_SCOPE_REGISTRY[source], `${source} is not an API-key scope`).toBeDefined();
    }
  });

  it('holds exactly the webhook admin area O-1 opened, both halves (O-2)', () => {
    // O-1 opened `:write` only and pinned `:read` as deliberately un-minted.
    // O-2 (owner, 2026-08-19) mints the read half too, so the delivery log is
    // reachable by a read-only grant. Order is the source list's own.
    expect([...ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES]).toEqual(['webhook:event:read', 'webhook:event:write']);
    expect([...ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES]).toEqual(['svc:webhook:event:read', 'svc:webhook:event:write']);
  });

  it('each one is registered and implies EXACTLY what its API-key source implies', () => {
    for (const source of ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES) {
      const svcScope = toServiceAccountScope(source);
      expect(isValidServiceAccountScope(svcScope), `${svcScope} must be a registry member`).toBe(true);
      expect(resolveServiceAccountImpliedPermissions(svcScope)).toEqual(API_KEY_SCOPE_REGISTRY[source]!.implies);
    }
  });

  it('resolves to a NON-EMPTY ability set on both halves (boot audit D, trap)', () => {
    for (const svcScope of ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES) {
      expect(resolveServiceAccountImpliedPermissions(svcScope).length, `${svcScope} grants nothing`).toBeGreaterThan(0);
      // Each half carries its API-key source's abilities verbatim — the derivation
      // never invents one. `:read` must include `read:WebhookRunHistory`, or it
      // would clear the scope gate on the delivery log and then be 403'd by CASL
      // (the trap this assertion exists to catch).
      expect(serviceAccountPolicyRules([svcScope])).toEqual(API_KEY_SCOPE_REGISTRY[svcScope.slice('svc:'.length)]!.implies);
    }
  });

  it('is DISJOINT from the API-key registry in both directions', () => {
    for (const source of ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES) {
      expect(isValidScope(toServiceAccountScope(source)), `${toServiceAccountScope(source)} must NOT be an API-key scope`).toBe(false);
      expect(isValidServiceAccountScope(source), `${source} must NOT be a service-account scope`).toBe(false);
    }
  });

  it('is disjoint from the standalone-feature family — one scope, one family, one justification', () => {
    for (const svcScope of ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES) {
      expect(STANDALONE_FEATURE_SVC_SCOPES).not.toContain(svcScope);
    }
  });

  it('svc:admin:* does NOT reach it — the admin wildcard means the admin: PREFIX, not the admin plane', () => {
    // The deliberate consequence of keeping the families separate: a machine
    // identity holding `svc:admin:*` still cannot write webhooks. The scope is
    // granted explicitly or not at all, which is the non-widening property the
    // registry header exists to protect.
    for (const svcScope of ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES) {
      expect(svcScope.startsWith('svc:admin:')).toBe(false);
      expect(hasServiceAccountScope(['svc:admin:*'], svcScope), `svc:admin:* must not reach ${svcScope}`).toBe(false);
    }
  });

  it('svc:* DOES reach it — the unrestricted platform wildcard is unrestricted', () => {
    for (const svcScope of ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES) {
      expect(hasServiceAccountScope(['svc:*'], svcScope)).toBe(true);
    }
  });

  it('holding it reaches no other area', () => {
    expect(hasServiceAccountScope(['svc:webhook:event:write'], 'svc:admin:user:write')).toBe(false);
    expect(hasServiceAccountScope(['svc:webhook:event:write'], 'svc:stt:stream:write')).toBe(false);
    expect(hasServiceAccountScope(['svc:admin:user:write'], 'svc:webhook:event:write')).toBe(false);
  });

  it('mints the read twin (O-2) but still no wildcard — silence remains a refusal', () => {
    // O-1 refused `:read` because nothing needed it; O-2 gave it a consumer
    // (`GET admin/webhooks/:id/deliveries`). The WILDCARD stays un-minted: a
    // family opens one named scope at a time, never a prefix.
    expect(isValidServiceAccountScope('svc:webhook:event:read')).toBe(true);
    expect(isValidServiceAccountScope('svc:webhook:*')).toBe(false);
  });

  it('the read half implies the delivery-log ability its only route demands', () => {
    expect(resolveServiceAccountImpliedPermissions('svc:webhook:event:read')).toContainEqual({ action: 'read', subject: 'WebhookRunHistory' });
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

/**
 * TASK-930 §3 — the FOURTH `svc:` family: the agent/workflow BUSINESS plane.
 *
 * A service account could reach every admin area and three standalone features, but not the
 * two planes a machine identity most obviously exists to drive — invoking a published agent and
 * running a published workflow. These five are a family of their own for the same reason the
 * other three are kept apart: `STANDALONE_FEATURE_SCOPE_SOURCES` means "standalone features an
 * end user drives through the SDK/compat surfaces", and a constant whose name stops describing
 * its contents is how the NEXT scope gets mis-derived.
 *
 * The consultation-bound plane (`workflows:` plural) is deliberately absent — it writes real
 * `ContextItem` rows against a patient's consultation, which is not a machine-identity surface
 * this ticket opens. Deny-by-default means that silence is a refusal, not an oversight.
 */
describe('TASK-930 §3 — the agent/workflow business-plane family', () => {
  it('names exactly the five business-plane scopes', () => {
    expect([...AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES]).toEqual([
      'agent:definition:read',
      'agent:invocation:write',
      'workflow:definition:read',
      'workflow:run:read',
      'workflow:run:write',
    ]);
  });

  it('registers each one under the svc: namespace with the SAME abilities the API-key scope carries', () => {
    for (const source of AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES) {
      const svc = toServiceAccountScope(source);
      expect(SERVICE_ACCOUNT_SCOPE_REGISTRY[svc], `${svc} must be registered`).toBeDefined();
      expect(SERVICE_ACCOUNT_SCOPE_REGISTRY[svc].implies).toEqual(API_KEY_SCOPE_REGISTRY[source].implies);
    }
  });

  // The trap the whole file exists for: a registered scope with no ability passes
  // `hasServiceAccountScope` and is then refused by CASL.
  it('resolves every one to at least one ability', () => {
    for (const svc of AGENT_WORKFLOW_BUSINESS_PLANE_SVC_SCOPES) {
      expect(resolveServiceAccountImpliedPermissions(svc).length, `${svc} resolves to no ability`).toBeGreaterThan(0);
    }
  });

  // `svc:admin:*` expands over the `svc:admin:` PREFIX, not over "everything a machine may do":
  // this family is granted explicitly or not at all.
  it('is NOT reachable through the svc:admin:* wildcard', () => {
    expect(hasServiceAccountScope(['svc:admin:*'], 'svc:agent:invocation:write')).toBe(false);
    expect(hasServiceAccountScope(['svc:*'], 'svc:agent:invocation:write')).toBe(true);
  });

  // The consultation-bound plural plane is opened by the FIFTH family below
  // (owner decision, 2026-09-09) under `svc:workflows:execute` and NOTHING else: no other
  // `workflows:` string is registered, so the plural namespace confers exactly the one scope
  // that was granted on purpose.
  it('admits the consultation-bound workflows: plane only through svc:workflows:execute', () => {
    expect(SERVICE_ACCOUNT_SCOPE_REGISTRY['svc:workflows:execute']).toBeDefined();
    expect(SERVICE_ACCOUNT_SCOPE_REGISTRY['svc:workflows:run:write']).toBeUndefined();
    expect(SERVICE_ACCOUNT_SCOPE_REGISTRY['svc:workflows:*']).toBeUndefined();
  });
});

/**
 * TASK-933 §3.1 — the FIFTH family: the REALTIME CONSULTATION plane.
 *
 * A service account could invoke agents and run unbound workflows (the fourth family) but could
 * not drive a CONSULTATION: open one for a named clinician, read it back, stream its live planes,
 * read the finalized note, discover the tenant's context schema, or reach the consultation-bound
 * workflows plane. Every one of those routes declared no `svc:*` scope, so
 * `enforceServiceAccountScopes` denied by default.
 *
 * Kept as its own family for the reason every family before it is: the constants above mean
 * "standalone SDK/compat features", "an admin area whose scope predates the convention" and
 * "the agent/workflow composition plane". A realtime clinical consultation is none of those, and
 * a constant whose name stops describing its contents is how the NEXT scope gets mis-derived.
 *
 * This family SUPERSEDES the fourth family's recorded exclusion of the consultation-bound
 * `workflows:` (plural) plane — an owner decision of 2026-09-09, not a refactor.
 */
describe('TASK-933 §3.1 — the realtime-consultation family', () => {
  it('names exactly the five realtime-consultation scopes', () => {
    expect([...CONSULTATION_REALTIME_SCOPE_SOURCES]).toEqual([
      'consultation:session:write',
      'consultation:session:read',
      'consultation:report:read',
      'tenant:context-schema:read',
      'workflows:execute',
    ]);
  });

  it('every declared source is a real API-key scope — the family is DERIVED, never invented', () => {
    for (const source of CONSULTATION_REALTIME_SCOPE_SOURCES) {
      expect(API_KEY_SCOPE_REGISTRY[source], `${source} must exist in API_KEY_SCOPE_REGISTRY`).toBeDefined();
    }
  });

  it('registers each one under the svc: namespace with the SAME abilities the API-key scope carries', () => {
    for (const source of CONSULTATION_REALTIME_SCOPE_SOURCES) {
      const svc = toServiceAccountScope(source);
      expect(SERVICE_ACCOUNT_SCOPE_REGISTRY[svc], `${svc} must be registered`).toBeDefined();
      expect(SERVICE_ACCOUNT_SCOPE_REGISTRY[svc].implies).toEqual(API_KEY_SCOPE_REGISTRY[source].implies);
    }
  });

  // The trap the whole file exists for: a registered scope with no ability passes
  // `hasServiceAccountScope` and is then refused by CASL.
  it('resolves every one to at least one ability, on BOTH halves', () => {
    for (const svc of CONSULTATION_REALTIME_SVC_SCOPES) {
      expect(resolveServiceAccountImpliedPermissions(svc).length, `${svc} resolves to no ability`).toBeGreaterThan(0);
      expect(serviceAccountPolicyRules([svc]).length, `${svc} contributes no CASL rule`).toBeGreaterThan(0);
    }
  });

  // `svc:admin:*` expands over the `svc:admin:` PREFIX, not over "everything a machine may do".
  it('is NOT reachable through the svc:admin:* wildcard', () => {
    for (const svc of CONSULTATION_REALTIME_SVC_SCOPES) {
      expect(hasServiceAccountScope(['svc:admin:*'], svc), `svc:admin:* must not cover ${svc}`).toBe(false);
      expect(hasServiceAccountScope(['svc:*'], svc), `svc:* must cover ${svc}`).toBe(true);
    }
  });

  it('is disjoint from every other family — one scope, one family, one justification', () => {
    for (const svc of CONSULTATION_REALTIME_SVC_SCOPES) {
      expect(STANDALONE_FEATURE_SVC_SCOPES).not.toContain(svc);
      expect(ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES).not.toContain(svc);
      expect(AGENT_WORKFLOW_BUSINESS_PLANE_SVC_SCOPES).not.toContain(svc);
      expect(svc.startsWith('svc:admin:')).toBe(false);
    }
  });

  it('is DISJOINT from the API-key registry in both directions', () => {
    for (const svc of CONSULTATION_REALTIME_SVC_SCOPES) {
      expect(isValidScope(svc), `${svc} must NOT be a valid API-key scope`).toBe(false);
      expect(isValidServiceAccountScope(svc), `${svc} must be a valid service-account scope`).toBe(true);
    }
  });

  // The singular `workflow:` family and the plural `workflows:` plane must not leak into one
  // another through `hasServiceAccountScope`'s parent-prefix rule.
  it('svc:workflows:execute is not reachable from the singular svc:workflow family, or vice versa', () => {
    expect(hasServiceAccountScope(['svc:workflow'], 'svc:workflows:execute')).toBe(false);
    expect(hasServiceAccountScope(['svc:workflow:run:write'], 'svc:workflows:execute')).toBe(false);
    expect(hasServiceAccountScope(['svc:workflows:execute'], 'svc:workflow:run:write')).toBe(false);
  });

  // Reading a consultation must never confer writing one: the read scopes carry `read` alone.
  it('the read scopes never imply a create ability', () => {
    for (const svc of ['svc:consultation:session:read', 'svc:consultation:report:read']) {
      const implied = resolveServiceAccountImpliedPermissions(svc);
      expect(implied.every((p) => p.action === 'read')).toBe(true);
    }
  });
});
