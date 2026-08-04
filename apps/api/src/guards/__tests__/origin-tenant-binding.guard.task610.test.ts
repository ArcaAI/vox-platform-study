// TASK-610 §3.6 T-5 — OriginTenantBindingGuard (lane W3-B).
//
// This guard is FR-4: the ACTUAL tenant-isolation control for browser
// origins. CORS is advisory browser behaviour and proves nothing about a
// caller; this guard is what stops a browser on tenant A's origin acting on
// tenant B's data. Every rule below has a failure mode that is SILENT — the
// wrong requests are simply allowed (or the platform quietly breaks) with
// nothing going red — so each one is pinned here.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { normalizeOrigin, type IOriginRegistry } from '@arcaai/applications';
import { OriginTenantBindingGuard } from '../origin-tenant-binding.guard';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

/**
 * A registry double that keys its map exactly the way the real
 * `OriginRegistryService` does — through the REAL `normalizeOrigin`, then
 * lowercased, never throwing on malformed input
 * (`origin-registry.service.ts#toLookupKey`).
 *
 * Using the real normalizer rather than a hand-stubbed `ownerOf` is what
 * makes the case/default-port cases below meaningful: they prove the GUARD
 * hands the raw `Origin` header straight through, un-mangled, so the
 * registry's normalization actually applies end-to-end. A registry stubbed
 * with `vi.fn()` returning a fixed owner would pass those tests even if the
 * guard pre-processed (or mis-cased) the header itself.
 */
const createRegistry = (rows: Record<string, string>): IOriginRegistry => {
  const toKey = (raw: string): string | null => {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
      return normalizeOrigin(raw).origin.toLowerCase();
    } catch {
      return null;
    }
  };

  const index = new Map<string, string>();
  for (const [origin, tenantId] of Object.entries(rows)) {
    const key = toKey(origin);
    if (key === null) throw new Error(`test fixture origin is not normalizable: ${origin}`);
    index.set(key, tenantId);
  }

  return {
    ownerOf: (origin: string) => {
      const key = toKey(origin);
      return key === null ? null : (index.get(key) ?? null);
    },
    has: (origin: string) => {
      const key = toKey(origin);
      return key === null ? false : index.has(key);
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

describe('OriginTenantBindingGuard (TASK-610 T-5, FR-4)', () => {
  let registry: IOriginRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = createRegistry({
      'https://console.arcaai.example': SYSTEM_TENANT_ID,
      'https://a.example': TENANT_A,
      'https://b.example': TENANT_B,
      'https://x.org': TENANT_A,
      'https://port.example:4433': TENANT_A,
    });
  });

  describe('rule 1 — no Origin header passes through', () => {
    it('allows a request with no Origin header at all (server-to-server / CLI / internal)', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(guard.canActivate(createContext({}))).toBe(true);
    });

    it('does not even consult the registry when no Origin header is present', () => {
      const ownerOf = vi.spyOn(registry, 'ownerOf');
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      guard.canActivate(createContext({}));

      expect(ownerOf).not.toHaveBeenCalled();
    });

    it('treats an empty-string Origin as absent', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(guard.canActivate(createContext({ origin: '' }))).toBe(true);
    });
  });

  describe('rule 2 — a SYSTEM-owned origin is valid for every tenant', () => {
    it('allows the SYSTEM console origin for tenant A', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_A }), registry);

      expect(guard.canActivate(createContext({ origin: 'https://console.arcaai.example' }))).toBe(true);
    });

    it('allows the SYSTEM console origin for tenant B', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(guard.canActivate(createContext({ origin: 'https://console.arcaai.example' }))).toBe(true);
    });
  });

  describe('rule 3 — otherwise owner must equal the resolved tenant', () => {
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

  describe('rule 4 — no resolved tenant passes through', () => {
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

  describe('unregistered origin — documented decision: pass through', () => {
    it('allows an origin that is not in the registry (no owner ⇒ no binding to violate)', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(guard.canActivate(createContext({ origin: 'https://unregistered.example' }))).toBe(true);
    });

    it('allows the dev loopback origin, which cors.config admits without a registry row', () => {
      const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_B }), registry);

      expect(guard.canActivate(createContext({ origin: 'http://localhost:5173' }))).toBe(true);
    });

    it('serves every tenant when the registry is empty (FR-6 bootstrap fallback must not be defeated)', () => {
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

    it('allows HTTPS://X.ORG for its owner tenant A', () => {
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
