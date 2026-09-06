/**
 * `@arcaai/vox` is business-plane only (TASK-890, OD-F/OD-K).
 *
 * `AgenticClient` used to stash the admin's own JWT in a WeakMap during
 * impersonation and route admin-plane requests (`/admin/*`) with it so
 * backend RBAC saw the admin's roles. The SDK carries no management surface
 * any more, so admin-plane requests are now REFUSED outright — with a named
 * `AdminPlaneRefusedError` — regardless of impersonation state. User-plane
 * routes are unaffected: they keep receiving the active token (the
 * impersonated user's token while impersonating, else the caller's own).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgenticClient } from '../AgenticClient';
import { AdminPlaneRefusedError, isAdminPlanePath } from '../constants';
import { mockFetch, createMockResponse, createMockLogger } from '../../__tests__/setup';

const ADMIN_TOKEN = 'admin-jwt-token';
const IMP_TOKEN = 'impersonation-jwt-token';

function authHeaderOf(callIndex = 0): string | undefined {
  const call = mockFetch.mock.calls[callIndex];
  const init = call?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.['Authorization'];
}

describe('isAdminPlanePath', () => {
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
    expect(isAdminPlanePath('/tenants/me/config')).toBe(false); // @Authorize() route
    expect(isAdminPlanePath('/users/me/settings')).toBe(false);
    expect(isAdminPlanePath('/auth/impersonate')).toBe(false);
    expect(isAdminPlanePath('/administrators')).toBe(false); // not a /admin/ segment
  });
});

describe('AgenticClient admin-plane refusal', () => {
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

    it('refuses an admin-plane request with a named error, and makes NO network call', async () => {
      await expect(client.get('/admin/audit-logs')).rejects.toThrow(AdminPlaneRefusedError);
      expect(mockFetch).not.toHaveBeenCalled();
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

    it('still refuses an admin-plane request after updateImpersonationOriginalToken', async () => {
      client.updateImpersonationOriginalToken('admin-jwt-token-v2');
      await expect(client.get('/admin/audit-logs')).rejects.toThrow(AdminPlaneRefusedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('keeps the impersonation token on user-plane after the admin stash is refreshed', async () => {
      client.updateImpersonationOriginalToken('admin-jwt-token-v2');
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/consultations');
      expect(authHeaderOf()).toBe(`Bearer ${IMP_TOKEN}`);
    });
  });

  describe('when NOT impersonating', () => {
    it('refuses an admin-plane request with a named error, and makes NO network call', async () => {
      await expect(client.get('/admin/audit-logs')).rejects.toThrow(AdminPlaneRefusedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sends the access token for a user-plane request', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/consultations');
      expect(authHeaderOf()).toBe(`Bearer ${ADMIN_TOKEN}`);
    });

    it('updateImpersonationOriginalToken is a no-op when not impersonating, and admin-plane still refuses', async () => {
      client.updateImpersonationOriginalToken('should-be-ignored');
      await expect(client.get('/admin/audit-logs')).rejects.toThrow(AdminPlaneRefusedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
