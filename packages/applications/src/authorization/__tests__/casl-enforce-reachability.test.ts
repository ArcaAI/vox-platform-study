/**
 * TASK-781 — a listed enforce pair must be able to FIRE.
 *
 * TASK-712 listed `read/update/delete:ApiKey` in `CASL_ENFORCED_PAIRS`, and
 * TASK-779 proved by e2e that none of them could ever produce the 403 the list
 * describes: the route's resolver loads its row through a 404-throwing
 * accessor, so on exactly the request the pair exists to deny the resolver
 * throws and the guard fails open. `casl_enforce_denial_total` therefore could
 * not increment — and a counter that reads zero because it CANNOT fire is
 * indistinguishable from one that reads zero because nothing diverged.
 *
 * `assertCaslEnforcePairReachability` is the structural guard against that
 * defect class. It is a pure function over a route table so this suite can pin
 * its behaviour on SYNTHETIC routes — which matters, because the shipped
 * enforce list is empty and the boot audit that calls it therefore passes
 * vacuously today. The proof that it would have caught F-1 lives here.
 */
import { describe, it, expect } from 'vitest';
import { assertCaslEnforcePairReachability, type EnforceRouteDescriptor } from '../enforce-reachability';

const route = (overrides: Partial<EnforceRouteDescriptor> = {}): EnforceRouteDescriptor => ({
  id: 'GET /admin/api-keys/:id (ApiKeyController.fetchById)',
  permissions: [{ action: 'read', subject: 'ApiKey' }],
  mode: 'AND',
  resolver: { subject: 'ApiKey', enforceGrade: true },
  ...overrides,
});

describe('assertCaslEnforcePairReachability', () => {
  it('accepts a pair declared on an AND-mode route with an enforce-grade resolver', () => {
    expect(() => assertCaslEnforcePairReachability(new Set(['read:ApiKey']), [route()])).not.toThrow();
  });

  it('an EMPTY enforce list is vacuously reachable — nothing is claimed, nothing can lie', () => {
    expect(() => assertCaslEnforcePairReachability(new Set(), [route()])).not.toThrow();
  });

  it('THE F-1 SHAPE: a pair whose only resolver is NOT enforce-grade is rejected', () => {
    // This is exactly TASK-779 F-1: the route exists, the resolver exists, and
    // the resolver delegates to an accessor that throws for a non-owned row,
    // so it can never return an instance on the deny case.
    const routes = [route({ resolver: { subject: 'ApiKey', enforceGrade: false } })];
    expect(() => assertCaslEnforcePairReachability(new Set(['read:ApiKey']), routes)).toThrow(/read:ApiKey/);
    expect(() => assertCaslEnforcePairReachability(new Set(['read:ApiKey']), routes)).toThrow(/enforce-grade/i);
  });

  it('rejects a pair no route declares at all', () => {
    expect(() => assertCaslEnforcePairReachability(new Set(['delete:Ghost']), [route()])).toThrow(/delete:Ghost/);
    expect(() => assertCaslEnforcePairReachability(new Set(['delete:Ghost']), [route()])).toThrow(/no route declares/i);
  });

  it('rejects a pair whose declaring routes carry no resolver', () => {
    const routes = [route({ resolver: undefined })];
    expect(() => assertCaslEnforcePairReachability(new Set(['read:ApiKey']), routes)).toThrow(/read:ApiKey/);
  });

  it('rejects a pair whose resolver declares a DIFFERENT subject — the instance can never match', () => {
    const routes = [route({ resolver: { subject: 'Consultation', enforceGrade: true } })];
    expect(() => assertCaslEnforcePairReachability(new Set(['read:ApiKey']), routes)).toThrow(/read:ApiKey/);
  });

  it('R4: an OR-mode route declaring an enforced pair is a boot failure', () => {
    // `@CanAny` semantics: the type-only verdict allows via alternative B, then
    // the enforced denial from alternative A throws 403 — silently turning the
    // route's OR into an AND. Structurally impossible rather than documented.
    const routes = [
      route(),
      route({
        id: 'GET /admin/api-keys/:id/usage (ApiKeyController.usage)',
        mode: 'OR',
        permissions: [
          { action: 'read', subject: 'ApiKey' },
          { action: 'manage', subject: 'Tenant' },
        ],
      }),
    ];
    expect(() => assertCaslEnforcePairReachability(new Set(['read:ApiKey']), routes)).toThrow(/OR mode/i);
  });

  it('one reachable route is enough — a collection route with no instance does not disqualify the pair', () => {
    // `@CanRead('ApiKey')` also sits on `fetchAll`, which has no `:id` and so
    // can never resolve an instance. That is correct, not drift: `list` is
    // deliberately never an enforced action.
    const routes = [route({ id: 'GET /admin/api-keys (fetchAll)', resolver: undefined }), route()];
    expect(() => assertCaslEnforcePairReachability(new Set(['read:ApiKey']), routes)).not.toThrow();
  });

  it('reports EVERY unreachable pair in one message, not just the first', () => {
    const routes = [route({ resolver: { subject: 'ApiKey', enforceGrade: false } })];
    let message = '';
    try {
      assertCaslEnforcePairReachability(new Set(['read:ApiKey', 'delete:Ghost']), routes);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('read:ApiKey');
    expect(message).toContain('delete:Ghost');
  });
});
