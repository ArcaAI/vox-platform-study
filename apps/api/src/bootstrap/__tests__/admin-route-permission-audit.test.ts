/**
 * Phase 0 Item 3 (TASK-302 Stream A) — boot-time admin route audit pin.
 *
 * The audit walks the Express router after Nest is built and refuses
 * to start if any path matching ^/(api/v\d+/)?admin/ lacks both
 * REQUIRED_PERMISSIONS_KEY and SKIP_AUTH_KEY metadata. Tests use a
 * minimal mock that mirrors the real Express + Nest layer shape.
 */

import { describe, it, expect } from 'vitest';
import { auditAdminRoutePermissions } from '../admin-route-permission-audit';
import { REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY } from '@arcaai/applications';

const fakeApp = (
  routes: Array<{ path: string; method: string; metadata: Record<string, unknown> }>,
) => ({
  getHttpAdapter: () => ({
    getInstance: () => ({
      _router: {
        stack: routes.map((r) => ({
          route: { path: r.path, methods: { [r.method.toLowerCase()]: true } },
          handle: Object.assign(() => undefined, { __metadata: r.metadata }),
        })),
      },
    }),
  }),
});

describe('Phase 0 Item 3 — boot-time admin route permission audit', () => {
  it('passes when every admin route declares required_permissions', () => {
    const app = fakeApp([
      {
        path: '/api/v1/admin/users',
        method: 'GET',
        metadata: { [REQUIRED_PERMISSIONS_KEY]: [{ action: 'manage', subject: 'User' }] },
      },
    ]);
    expect(() => auditAdminRoutePermissions(app as never)).not.toThrow();
  });

  it('passes on a public admin route marked @Public()', () => {
    const app = fakeApp([
      {
        path: '/api/v1/admin/pstudio',
        method: 'GET',
        metadata: { [SKIP_AUTH_KEY]: true },
      },
    ]);
    expect(() => auditAdminRoutePermissions(app as never)).not.toThrow();
  });

  it('throws when an admin route is missing required_permissions', () => {
    const app = fakeApp([
      { path: '/api/v1/admin/orphans', method: 'GET', metadata: {} },
    ]);
    expect(() => auditAdminRoutePermissions(app as never)).toThrow(
      /admin\/orphans.*missing.*permission/i,
    );
  });

  it('ignores non-admin routes even when they have no metadata', () => {
    const app = fakeApp([
      { path: '/api/v1/consultations', method: 'GET', metadata: {} },
      { path: '/api/v1/auth/login', method: 'POST', metadata: {} },
    ]);
    expect(() => auditAdminRoutePermissions(app as never)).not.toThrow();
  });
});
