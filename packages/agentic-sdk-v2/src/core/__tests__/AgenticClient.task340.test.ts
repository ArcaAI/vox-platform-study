/**
 * TASK-340 — Impersonation must not block administration interfaces.
 *
 * During impersonation the SDK stashes the admin's own JWT in a WeakMap while
 * `accessToken` holds the short-lived impersonation JWT. Admin-plane routes
 * (`/admin/*`) MUST be sent with the admin's own JWT so backend RBAC sees the
 * admin's roles; user-plane routes keep the impersonation JWT so the SDK acts
 * as the impersonated user. When NOT impersonating, nothing changes.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgenticClient } from '../AgenticClient';
import { isAdminPlanePath } from '../constants';
import { mockFetch, createMockResponse, createMockLogger } from '../../__tests__/setup';

const ADMIN_TOKEN = 'admin-jwt-token';
const IMP_TOKEN = 'impersonation-jwt-token';

function authHeaderOf(callIndex = 0): string | undefined {
  const call = mockFetch.mock.calls[callIndex];
  const init = call?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.['Authorization'];
}

describe('TASK-340 — isAdminPlanePath', () => {
  it('matches admin-plane paths', () => {
    expect(isAdminPlanePath('/admin/tenants')).toBe(true);
    expect(isAdminPlanePath('/admin/audit-logs')).toBe(true);
    expect(isAdminPlanePath('/admin/audio/pipelines')).toBe(true);
    expect(isAdminPlanePath('/admin/tenant-frontend-config')).toBe(true);
    expect(isAdminPlanePath('admin/tenants')).toBe(true); // no leading slash
    expect(isAdminPlanePath('/api/v1/admin/tenants')).toBe(true); // fully-qualified
    expect(isAdminPlanePath('/admin/tenants?page=1')).toBe(true); // query string
  });

  it('does NOT match user-plane paths', () => {
    expect(isAdminPlanePath('/consultations')).toBe(false);
    expect(isAdminPlanePath('/dna-writing-styles/mine')).toBe(false);
    expect(isAdminPlanePath('/audio/pipelines')).toBe(false); // read plane
    expect(isAdminPlanePath('/tenant/me/config')).toBe(false); // @Authorize() route
    expect(isAdminPlanePath('/user/me/settings')).toBe(false);
    expect(isAdminPlanePath('/auth/impersonate')).toBe(false);
    expect(isAdminPlanePath('/administrators')).toBe(false); // not a /admin/ segment
  });
});

describe('TASK-340 — AgenticClient admin-plane token routing', () => {
  let client: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    client = new AgenticClient({ baseUrl: 'https://api.example.com', tenantId: 'tenant-123' }, mockLogger);
    client.updateAccessToken(ADMIN_TOKEN);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('while impersonating', () => {
    beforeEach(() => {
      // Mirror the real flow: stash admin token, then swap in the impersonation token.
      client.startImpersonation(ADMIN_TOKEN);
      client.updateAccessToken(IMP_TOKEN);
    });

    it('sends the ADMIN token for an admin-plane request', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/admin/audit-logs');
      expect(authHeaderOf()).toBe(`Bearer ${ADMIN_TOKEN}`);
    });

    it('sends the IMPERSONATION token for a user-plane request', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/consultations');
      expect(authHeaderOf()).toBe(`Bearer ${IMP_TOKEN}`);
    });

    it('sends the IMPERSONATION token for a user-plane DNA route', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/dna-writing-styles/mine');
      expect(authHeaderOf()).toBe(`Bearer ${IMP_TOKEN}`);
    });

    it('uses a refreshed admin token for admin-plane requests after updateImpersonationOriginalToken', async () => {
      client.updateImpersonationOriginalToken('admin-jwt-token-v2');
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/admin/audit-logs');
      expect(authHeaderOf()).toBe('Bearer admin-jwt-token-v2');
    });

    it('keeps the impersonation token on user-plane after the admin stash is refreshed', async () => {
      client.updateImpersonationOriginalToken('admin-jwt-token-v2');
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/consultations');
      expect(authHeaderOf()).toBe(`Bearer ${IMP_TOKEN}`);
    });
  });

  describe('when NOT impersonating (unchanged behavior)', () => {
    it('sends the access token for an admin-plane request', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/admin/audit-logs');
      expect(authHeaderOf()).toBe(`Bearer ${ADMIN_TOKEN}`);
    });

    it('sends the access token for a user-plane request', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/consultations');
      expect(authHeaderOf()).toBe(`Bearer ${ADMIN_TOKEN}`);
    });

    it('updateImpersonationOriginalToken is a no-op when not impersonating', async () => {
      client.updateImpersonationOriginalToken('should-be-ignored');
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/admin/audit-logs');
      expect(authHeaderOf()).toBe(`Bearer ${ADMIN_TOKEN}`);
    });
  });
});
