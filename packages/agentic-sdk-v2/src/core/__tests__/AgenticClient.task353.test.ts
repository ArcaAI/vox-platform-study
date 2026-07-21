/**
 * Admin-only routes OUTSIDE the `/admin/` prefix must also carry
 * the admin's own JWT during impersonation.
 *
 * The backend gates `/monitoring/*` (whole controller) and
 * `/health/services[/:serviceKey]` behind `@Authorize(['manage', 'all'])`,
 * but `isAdminPlanePath` only matched `/admin/*`.
 * While impersonating a doctor, these endpoints received the impersonation JWT
 * and returned 403 — e.g. the entire /admin/system-health page broke.
 *
 * Other `/health/*` probes (`/health`, `/health/live`, `/health/ready`) are
 * unrestricted and stay on the user-plane path.
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

describe('TASK-353 — isAdminPlanePath covers non-/admin admin-only routes', () => {
  it('matches /monitoring/* (entire controller is manage:all)', () => {
    expect(isAdminPlanePath('/monitoring/uptime')).toBe(true);
    expect(isAdminPlanePath('/monitoring/sessions')).toBe(true);
    expect(isAdminPlanePath('/monitoring/uptime/smr')).toBe(true);
    expect(isAdminPlanePath('/monitoring/heartbeats/stt')).toBe(true);
    expect(isAdminPlanePath('monitoring/uptime')).toBe(true); // no leading slash
    expect(isAdminPlanePath('/api/v1/monitoring/uptime')).toBe(true); // fully-qualified
  });

  it('matches /health/services and /health/services/:serviceKey (manage:all)', () => {
    expect(isAdminPlanePath('/health/services')).toBe(true);
    expect(isAdminPlanePath('/health/services/smr')).toBe(true);
    expect(isAdminPlanePath('/health/services?verbose=1')).toBe(true); // query string
    expect(isAdminPlanePath('/api/v1/health/services')).toBe(true); // fully-qualified
  });

  it('does NOT match unrestricted health probes or look-alike paths', () => {
    expect(isAdminPlanePath('/health')).toBe(false);
    expect(isAdminPlanePath('/health/live')).toBe(false);
    expect(isAdminPlanePath('/health/ready')).toBe(false);
    expect(isAdminPlanePath('/health/servicesque')).toBe(false); // not the services segment
    expect(isAdminPlanePath('/monitoringx/uptime')).toBe(false); // not a /monitoring/ segment
  });
});

describe('TASK-353 — AgenticClient token routing for non-/admin admin-only routes', () => {
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
