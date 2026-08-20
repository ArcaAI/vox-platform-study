/**
 * Admin-only routes OUTSIDE the `/admin/` prefix must also carry
 * the admin's own JWT during impersonation.
 *
 * The backend gates `/monitoring/*` (whole controller) and
 * `/health/services[/:serviceKey]` behind CASL (`manage:all | read:TenantTelemetry`),
 * but `isAdminPlanePath` only matched `/admin/*`.
 * While impersonating a doctor, these endpoints received the impersonation JWT
 * and returned 403 — e.g. the entire /admin/system-health page broke.
 *
 * Other `/health/*` probes (`/health`, `/health/live`, `/health/ready`) are
 * unrestricted and stay on the user-plane path.
 *
 * TASK-759 filed both surfaces under `admin/` (`/admin/monitoring/*`,
 * `/admin/health/services*`), so the generic `admin/` branch now carries them
 * and the SDK's own endpoint constants emit the new paths. The legacy branches
 * are retained and still asserted below: a caller passing a hard-coded
 * pre-move path must still be classified admin-plane rather than silently
 * receiving the impersonation JWT.
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

describe('isAdminPlanePath covers non-/admin admin-only routes', () => {
  it('still matches the LEGACY /monitoring/* paths (pre-TASK-759 hard-coded callers)', () => {
    expect(isAdminPlanePath('/monitoring/uptime')).toBe(true);
    expect(isAdminPlanePath('/monitoring/sessions')).toBe(true);
    expect(isAdminPlanePath('/monitoring/uptime/text')).toBe(true);
    expect(isAdminPlanePath('/monitoring/heartbeats/stt')).toBe(true);
    expect(isAdminPlanePath('monitoring/uptime')).toBe(true); // no leading slash
    expect(isAdminPlanePath('/api/v1/monitoring/uptime')).toBe(true); // fully-qualified
  });

  it('still matches the LEGACY /health/services[/:serviceKey] paths (pre-TASK-759 hard-coded callers)', () => {
    expect(isAdminPlanePath('/health/services')).toBe(true);
    expect(isAdminPlanePath('/health/services/text')).toBe(true);
    expect(isAdminPlanePath('/health/services?verbose=1')).toBe(true); // query string
    expect(isAdminPlanePath('/api/v1/health/services')).toBe(true); // fully-qualified
  });

  it('matches the TASK-759 admin-plane paths through the generic admin/ branch', () => {
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

describe('AgenticClient token routing for non-/admin admin-only routes', () => {
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

    it('sends the ADMIN token for /monitoring/uptime', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/monitoring/uptime');
      expect(authHeaderOf()).toBe(`Bearer ${ADMIN_TOKEN}`);
    });

    it('sends the ADMIN token for /health/services', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/health/services');
      expect(authHeaderOf()).toBe(`Bearer ${ADMIN_TOKEN}`);
    });

    it('keeps the IMPERSONATION token for unrestricted /health/live', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/health/live');
      expect(authHeaderOf()).toBe(`Bearer ${IMP_TOKEN}`);
    });
  });

  describe('when NOT impersonating (unchanged behavior)', () => {
    it('sends the access token for /monitoring/uptime', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
      await client.get('/monitoring/uptime');
      expect(authHeaderOf()).toBe(`Bearer ${ADMIN_TOKEN}`);
    });
  });
});
