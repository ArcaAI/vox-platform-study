/**
 * Throttle decorator verification tests (TDD RED phase)
 *
 * These tests verify that the correct @Throttle() and @SkipThrottle()
 * decorators are applied to each controller class by checking Reflect metadata.
 */

import { describe, it, expect } from 'vitest';

const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

describe('Controller @Throttle() decorator overrides', () => {
    it('should apply strict throttle (10 req/60s) on AuthController', async () => {
        const { AuthController } = await import('../../auth/auth.controller');
        const limit = Reflect.getMetadata(THROTTLER_LIMIT + 'default', AuthController);
        const ttl = Reflect.getMetadata(THROTTLER_TTL + 'default', AuthController);
        expect(limit).toBe(10);
        expect(ttl).toBe(60000);
    });

    // TASK-307 W5.1 / AC-15 / audit D-11 — health throttle lowered from
    // 300 → 30 req/min. With `/services{/:key}` now @Authorize()-gated
    // and the SSRF amplifier surface (4 outbound calls per probe)
    // shrinking accordingly, the generous default for the remaining
    // probe endpoints (`/live`, `/ready`, `/startup`, `/`) is no
    // longer necessary; Kubernetes probes operate well under 30/min.
    it('should apply strict throttle (30 req/60s) on ApiHealthController', async () => {
        const { ApiHealthController } = await import('../../health/health.controller');
        const limit = Reflect.getMetadata(THROTTLER_LIMIT + 'default', ApiHealthController);
        const ttl = Reflect.getMetadata(THROTTLER_TTL + 'default', ApiHealthController);
        expect(limit).toBe(30);
        expect(ttl).toBe(60000);
    });

    it('should apply relaxed throttle (300 req/60s) on MonitoringController', async () => {
        const { MonitoringController } = await import('../../monitoring/monitoring.controller');
        const limit = Reflect.getMetadata(THROTTLER_LIMIT + 'default', MonitoringController);
        const ttl = Reflect.getMetadata(THROTTLER_TTL + 'default', MonitoringController);
        expect(limit).toBe(300);
        expect(ttl).toBe(60000);
    });
});
