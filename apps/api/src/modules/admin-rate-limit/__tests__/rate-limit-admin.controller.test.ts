/**
 * RateLimitAdminController unit tests.
 *
 * Verifies the thin controller delegates each route to IRateLimitAdminService
 * with the right arguments. Uses a local test class mirroring the controller
 * logic to avoid the @arcaai/applications barrel import in unit tests (same
 * pattern as monitoring.controller.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface SetTierInput {
  limit?: number;
  ttl?: number;
}
interface SetRouteInput {
  limit?: number;
  ttl?: number;
  enabled?: boolean;
}
interface RateLimitPolicy {
  enabled: boolean;
  enabledSource: string;
  tiers: unknown[];
  routes: unknown[];
}
interface IRateLimitAdminService {
  getPolicy(): RateLimitPolicy;
  setEnabled(enabled: boolean): Promise<RateLimitPolicy>;
  setTier(tier: string, input: SetTierInput): Promise<RateLimitPolicy>;
  setRoute(routeId: string, input: SetRouteInput): Promise<RateLimitPolicy>;
}

class TestRateLimitAdminController {
  constructor(private readonly rateLimitAdmin: IRateLimitAdminService) {}

  getPolicy(): RateLimitPolicy {
    return this.rateLimitAdmin.getPolicy();
  }
  setEnabled(body: { enabled: boolean }): Promise<RateLimitPolicy> {
    return this.rateLimitAdmin.setEnabled(body.enabled);
  }
  setTier(tier: string, body: SetTierInput): Promise<RateLimitPolicy> {
    return this.rateLimitAdmin.setTier(tier, body);
  }
  setRoute(routeId: string, body: SetRouteInput): Promise<RateLimitPolicy> {
    return this.rateLimitAdmin.setRoute(routeId, body);
  }
}

const createMockService = (): IRateLimitAdminService => ({
  getPolicy: vi.fn(),
  setEnabled: vi.fn(),
  setTier: vi.fn(),
  setRoute: vi.fn(),
});

const policy: RateLimitPolicy = { enabled: true, enabledSource: 'default', tiers: [], routes: [] };

describe('RateLimitAdminController', () => {
  let controller: TestRateLimitAdminController;
  let service: ReturnType<typeof createMockService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = createMockService();
    controller = new TestRateLimitAdminController(service);
  });

  it('GET / delegates to getPolicy', () => {
    (service.getPolicy as ReturnType<typeof vi.fn>).mockReturnValue(policy);
    expect(controller.getPolicy()).toBe(policy);
    expect(service.getPolicy).toHaveBeenCalledOnce();
  });

  it('PUT /enabled unwraps the body and delegates to setEnabled', async () => {
    (service.setEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(policy);
    await controller.setEnabled({ enabled: false });
    expect(service.setEnabled).toHaveBeenCalledWith(false);
  });

  it('PUT /tiers/:tier forwards the tier param and body to setTier', async () => {
    (service.setTier as ReturnType<typeof vi.fn>).mockResolvedValue(policy);
    await controller.setTier('strict', { limit: 25, ttl: 30000 });
    expect(service.setTier).toHaveBeenCalledWith('strict', { limit: 25, ttl: 30000 });
  });

  it('PUT /routes/:routeId forwards the routeId param and body to setRoute', async () => {
    (service.setRoute as ReturnType<typeof vi.fn>).mockResolvedValue(policy);
    await controller.setRoute('auth.login', { limit: 3, enabled: true });
    expect(service.setRoute).toHaveBeenCalledWith('auth.login', { limit: 3, enabled: true });
  });
});
