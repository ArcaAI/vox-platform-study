// OriginTenantBindingGuard, revised for
// many-to-many origins ↔ tenants.
//
// This guard is the ACTUAL tenant-isolation control for browser
// origins. CORS is advisory browser behaviour and proves nothing about a
// caller; this guard is what stops a browser on tenant A's origin acting on
// tenant B's data. Every rule below has a failure mode that is SILENT — the
// wrong requests are simply allowed (or the platform quietly breaks) with
// nothing going red — so each one is pinned here.
//
// `ownerOf(origin) → string | null` was replaced with
// `tenantsFor`/`has`/`allows`. The registry double below mirrors the real
// `OriginRegistryService`'s semantics: a Set of tenants per origin, `has`
// true iff that set is non-empty, and `allows` encapsulating the
// SYSTEM-admits-every-tenant rule so this guard never has to.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { normalizeOrigin, type IOriginRegistry } from '@arcaai/applications';
import { setOriginEnforcementResolver } from '../../cors.config';
import { OriginTenantBindingGuard } from '../origin-tenant-binding.guard';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const TENANT_C = '33333333-3333-3333-3333-333333333333';

/**
 * A registry double that keys its map exactly the way the real
 * `OriginRegistryService` does — through the REAL `normalizeOrigin`, then
 * lowercased, never throwing on malformed input
 * (`origin-registry.service.ts#toLookupKey`).
 *
 * Using the real normalizer rather than a hand-stubbed `allows`/`has` is what
 * makes the case/default-port cases below meaningful: they prove the GUARD
 * hands the raw `Origin` header straight through, un-mangled, so the
 * registry's normalization actually applies end-to-end. A registry stubbed
 * with `vi.fn()` returning a fixed answer would pass those tests even if the
 * guard pre-processed (or mis-cased) the header itself.
 *
 * Takes `Record<origin, tenantId[]>` — a list of tenants each origin is
 * GRANTED to (: one row per (origin, tenant) grant; the union of grants
 * is what `tenantsFor`/`allows` expose).
 */
const createRegistry = (rows: Record<string, string[]>): IOriginRegistry => {
  const toKey = (raw: string): string | null => {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
      return normalizeOrigin(raw).origin.toLowerCase();
    } catch {
      return null;
    }
  };

  const index = new Map<string, Set<string>>();
  for (const [origin, tenantIds] of Object.entries(rows)) {
    const key = toKey(origin);
    if (key === null) throw new Error(`test fixture origin is not normalizable: ${origin}`);
    index.set(key, new Set(tenantIds));
  }

  const tenantsFor = (origin: string): ReadonlySet<string> => {
    const key = toKey(origin);
    return key === null ? new Set<string>() : (index.get(key) ?? new Set<string>());
  };

  return {
    tenantsFor,
    has: (origin: string) => tenantsFor(origin).size > 0,
    allows: (origin: string, tenantId: string) => {
      const grantees = tenantsFor(origin);
      return grantees.has(tenantId) || grantees.has(SYSTEM_TENANT_ID);
    },
    refresh: vi.fn(async () => undefined),
    size: () => index.size,
  };
};

const createCls = (store: Record<string, unknown>, options: { active?: boolean } = {}): ClsService => {
  return {
    isActive: () => options.active ?? true,
    get: (key: string) => store[key],
  } as unknown as ClsService;
};

const createContext = (headers: Record<string, unknown> = {}, type: 'http' | 'ws' = 'http'): ExecutionContext => {
  const request = { headers, url: '/api/v1/consultations', method: 'GET' };
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handlerRef',
    getClass: () => 'classRef',
  } as unknown as ExecutionContext;
};

describe('OriginTenantBindingGuard (many-to-many)', () => {
  let registry: IOriginRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    // This guard is a pass-through unless `origin.enforcementEnabled`
    // is on. Enforcement ships ON (descriptor default `true`), so
    // arming the switch here reproduces the shipped posture rather than
    // overriding it; the dormant/off state is pinned in
    // `origin-tenant-binding.guard.enforcement.task610.test.ts`. It is still set
    // explicitly because `cors.config.ts` has no resolver installed in a unit
    // test — the descriptor default reaches it only through `PlatformKnobsBinder`.
    setOriginEnforcementResolver(() => true);
    registry = createRegistry({
      'https://console.arcaai.example': [SYSTEM_TENANT_ID],
      'https://a.example': [TENANT_A],
      'https://b.example': [TENANT_B],
      'https://x.org': [TENANT_A],
      'https://port.example:4433': [TENANT_A],
      // The high-value case: one origin granted to BOTH tenant A and
      // tenant B — impossible under the old single-owner index (a global
      // unique index on `origin` made the second tenant's grant a 409).
      'https://shared.example': [TENANT_A, TENANT_B],
    });
  });

  afterEach(() => {
    setOriginEnforcementResolver(null);
  });

  describe('the many-to-many case this lane exists for', () => {
    it('allows a shared origin for tenant A', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_A }), registry);

      expect(guard.canActivate(createContext({ origin: 'https://shared.example' }))).toBe(true);
    });

    it('allows the SAME shared origin for tenant B', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(guard.canActivate(createContext({ origin: 'https://shared.example' }))).toBe(true);
    });

    it('rejects the SAME shared origin for a THIRD tenant not in the grant set — 404', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_C }), registry);

      expect(() => guard.canActivate(createContext({ origin: 'https://shared.example' }))).toThrow(NotFoundException);
    });
  });

  describe('rule 1 — no Origin header passes through', () => {
    it('allows a request with no Origin header at all (server-to-server / CLI / internal)', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(guard.canActivate(createContext({}))).toBe(true);
    });

    it('does not even consult the registry when no Origin header is present', () => {
      const hasSpy = vi.spyOn(registry, 'has');
      const allowsSpy = vi.spyOn(registry, 'allows');
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      guard.canActivate(createContext({}));

      expect(hasSpy).not.toHaveBeenCalled();
      expect(allowsSpy).not.toHaveBeenCalled();
    });

    it('treats an empty-string Origin as absent', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(guard.canActivate(createContext({ origin: '' }))).toBe(true);
    });
  });

  describe('SYSTEM-granted origin is valid for every tenant (via allows(), not re-derived here)', () => {
    it('allows the SYSTEM console origin for tenant A', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_A }), registry);

      expect(guard.canActivate(createContext({ origin: 'https://console.arcaai.example' }))).toBe(true);
    });

    it('allows the SYSTEM console origin for tenant B', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(guard.canActivate(createContext({ origin: 'https://console.arcaai.example' }))).toBe(true);
    });
  });

  describe('otherwise allows() must admit the resolved tenant', () => {
    it('allows tenant A on tenant A’s own origin', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_A }), registry);

      expect(guard.canActivate(createContext({ origin: 'https://a.example' }))).toBe(true);
    });

    it('rejects tenant A’s origin on a request resolved to tenant B', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(() => guard.canActivate(createContext({ origin: 'https://a.example' }))).toThrow(NotFoundException);
    });

    it('rejects with 404, never 403 (404-over-403 cross-tenant posture)', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      try {
        guard.canActivate(createContext({ origin: 'https://a.example' }));
        expect.unreachable('expected the cross-tenant origin to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).getStatus()).toBe(404);
      }
    });

    it('resolves the tenant from the CLS user when `tenantId` is not set directly', () => {
      const guard = new OriginTenantBindingGuard(createCls({ user: { tenantId: TENANT_B } }), registry);

      expect(() => guard.canActivate(createContext({ origin: 'https://a.example' }))).toThrow(NotFoundException);
    });
  });

  describe('no resolved tenant passes through', () => {
    it('allows an unauthenticated request (no CLS tenant at all)', () => {
      const guard = new OriginTenantBindingGuard(createCls({}), registry);

      expect(guard.canActivate(createContext({ origin: 'https://a.example' }))).toBe(true);
    });

    it('allows a global admin, whose CLS tenantId is the empty string', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: '', user: { tenantId: '' } }), registry);

      expect(guard.canActivate(createContext({ origin: 'https://a.example' }))).toBe(true);
    });

    it('does not throw when there is no active CLS context at all', () => {
      const guard = new OriginTenantBindingGuard(
        {
          isActive: () => false,
          get: () => {
            throw new Error('cls.get() outside an active context');
          },
        } as unknown as ClsService,
        registry,
      );

      expect(guard.canActivate(createContext({ origin: 'https://a.example' }))).toBe(true);
    });
  });

  describe('unregistered origin (empty tenant set) — documented decision: pass through', () => {
    it('allows an origin that is not in the registry (empty grant set ⇒ no binding to violate)', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(guard.canActivate(createContext({ origin: 'https://unregistered.example' }))).toBe(true);
    });

    it('allows the dev loopback origin, which cors.config admits without a registry row', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(guard.canActivate(createContext({ origin: 'http://localhost:5173' }))).toBe(true);
    });

    it('serves every tenant when the registry is empty', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_A }), createRegistry({}));

      expect(guard.canActivate(createContext({ origin: 'https://a.example' }))).toBe(true);
    });
  });

  describe('malformed Origin header must not 500', () => {
    it.each([['not a url'], ['null'], ['*'], ['file:///etc/passwd'], ['https://a.example/path'], ['https://user:pw@a.example']])(
      'passes through %s without throwing',
      (raw) => {
        const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

        expect(guard.canActivate(createContext({ origin: raw }))).toBe(true);
      },
    );

    it('treats a duplicated (array-valued) Origin header as absent rather than throwing', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(guard.canActivate(createContext({ origin: ['https://a.example', 'https://b.example'] }))).toBe(true);
    });
  });

  describe('case and default-port variants resolve identically (raw header passed through un-mangled)', () => {
    it('rejects HTTPS://A.EXAMPLE for tenant B exactly as https://a.example is rejected', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(() => guard.canActivate(createContext({ origin: 'HTTPS://A.EXAMPLE' }))).toThrow(NotFoundException);
    });

    it('allows HTTPS://X.ORG for its granted tenant A', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_A }), registry);

      expect(guard.canActivate(createContext({ origin: 'HTTPS://X.ORG' }))).toBe(true);
    });

    it('treats https://x.org:443 identically to https://x.org (default port stripped)', () => {
      const allowed = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_A }), registry);
      const denied = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(allowed.canActivate(createContext({ origin: 'https://x.org:443' }))).toBe(true);
      expect(() => denied.canActivate(createContext({ origin: 'https://x.org:443' }))).toThrow(NotFoundException);
    });

    it('preserves a non-default port — :4433 is bound, and the portless host is NOT', () => {
      const owner = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_A }), registry);
      const other = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(owner.canActivate(createContext({ origin: 'https://port.example:4433' }))).toBe(true);
      expect(() => other.canActivate(createContext({ origin: 'https://port.example:4433' }))).toThrow(NotFoundException);
      // `https://port.example` (no port) is a DIFFERENT origin and is unregistered.
      expect(other.canActivate(createContext({ origin: 'https://port.example' }))).toBe(true);
    });
  });

  describe('non-HTTP execution contexts', () => {
    it('passes through a WebSocket context (the WS handshake has its own origin check, D-6/W3-C)', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(guard.canActivate(createContext({ origin: 'https://a.example' }, 'ws'))).toBe(true);
    });
  });
});
