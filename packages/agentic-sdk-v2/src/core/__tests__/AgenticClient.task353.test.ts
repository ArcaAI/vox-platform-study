/**
 * Admin-only routes OUTSIDE the `/admin/` prefix are refused too.
 *
 * The backend gates `/monitoring/*` (whole controller) and
 * `/health/services[/:serviceKey]` behind CASL (`manage:all | read:TenantTelemetry`),
 * so `isAdminPlanePath` also classifies them as admin-plane even though they
 * don't start with `/admin/`.
 *
 * Other `/health/*` probes (`/health`, `/health/live`, `/health/ready`) are
 * unrestricted and stay on the user-plane path.
 *
 * Both surfaces are ALSO filed under `admin/` (`/admin/monitoring/*`,
 * `/admin/health/services*`), so the generic `admin/` branch covers them too
 * and the SDK's own endpoint constants emit the new paths. The legacy
 * branches are retained and still asserted below: a caller passing a
 * hard-coded pre-move path must still be classified admin-plane rather than
 * silently receiving the impersonation JWT.
 *
 * `@arcaai/vox` is business-plane only (TASK-890, OD-F/OD-K): every
 * admin-plane path — legacy or current — is now REFUSED outright with a
 * named `AdminPlaneRefusedError`, not routed with an admin JWT.
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

describe('isAdminPlanePath covers non-/admin admin-only routes', () => {
  it('still matches the LEGACY /monitoring/* paths (pre-hard-coded callers)', () => {
    expect(isAdminPlanePath('/monitoring/uptime')).toBe(true);
    expect(isAdminPlanePath('/monitoring/sessions')).toBe(true);
    expect(isAdminPlanePath('/monitoring/uptime/text')).toBe(true);
    expect(isAdminPlanePath('/monitoring/heartbeats/stt')).toBe(true);
    expect(isAdminPlanePath('monitoring/uptime')).toBe(true); // no leading slash
    expect(isAdminPlanePath('/api/v1/monitoring/uptime')).toBe(true); // fully-qualified
  });

  it('still matches the LEGACY /health/services[/:serviceKey] paths (pre-hard-coded callers)', () => {
    expect(isAdminPlanePath('/health/services')).toBe(true);
    expect(isAdminPlanePath('/health/services/text')).toBe(true);
    expect(isAdminPlanePath('/health/services?verbose=1')).toBe(true); // query string
    expect(isAdminPlanePath('/api/v1/health/services')).toBe(true); // fully-qualified
  });

  it('matches the  admin-plane paths through the generic admin/ branch', () => {
    expect(isAdminPlanePath('/admin/monitoring/uptime')).toBe(true);
    expect(isAdminPlanePath('/admin/monitoring/sessions')).toBe(true);
    expect(isAdminPlanePath('/admin/health/services')).toBe(true);
    expect(isAdminPlanePath('/admin/health/services/text')).toBe(true);
    expect(isAdminPlanePath('/api/v1/admin/health/services')).toBe(true);
  });

  it('does NOT match unrestricted health probes or look-alike paths', () => {
    expect(isAdminPlanePath('/health')).toBe(false);
    expect(isAdminPlanePath('/health/live')).toBe(false);
    expect(isAdminPlanePath('/health/ready')).toBe(false);
    expect(isAdminPlanePath('/health/servicesque')).toBe(false); // not the services segment
    expect(isAdminPlanePath('/monitoringx/uptime')).toBe(false); // not a /monitoring/ segment
  });
});

describe('AgenticClient refusal for non-/admin admin-only routes', () => {
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
      client.startImpersonation(ADMIN_TOKEN);
      client.updateAccessToken(IMP_TOKEN);
    });

    it('refuses /monitoring/uptime with a named error, and makes NO network call', async () => {
      await expect(client.get('/monitoring/uptime')).rejects.toThrow(AdminPlaneRefusedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('refuses /health/services with a named error, and makes NO network call', async () => {
      await expect(client.get('/health/services')).rejects.toThrow(AdminPlaneRefusedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('keeps the IMPERSONATION token for unrestricted /health/live', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/health/live');
      expect(authHeaderOf()).toBe(`Bearer ${IMP_TOKEN}`);
    });
  });

  describe('when NOT impersonating', () => {
    it('refuses /monitoring/uptime with a named error, and makes NO network call', async () => {
      await expect(client.get('/monitoring/uptime')).rejects.toThrow(AdminPlaneRefusedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
