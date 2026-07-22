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
    // AuthController's class-wide throttle was removed; the
    // SDK aggressively polls /auth/me + /auth/refresh, and lumping every
    // endpoint under a single 10/min counter was tripping refresh under
    // production load. Per-endpoint decorators replace it (see the
    // dedicated block below).
    it('AuthController carries NO class-wide throttle', async () => {
        const { AuthController } = await import('../../auth/auth.controller');
        const limit = Reflect.getMetadata(THROTTLER_LIMIT + 'default', AuthController);
        const ttl = Reflect.getMetadata(THROTTLER_TTL + 'default', AuthController);
        expect(limit).toBeUndefined();
        expect(ttl).toBeUndefined();
    });

    // Health throttle lowered from
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

// ───────────────────────────────────────────────────────────────────────────
// Per-endpoint throttle granularity on AuthController.
//
// Rationale: the SDK (`@arcaai/vox`) routinely polls `/auth/me` and
// rotates `/auth/refresh` more often than the previous class-wide 10/min
// allowed, while `/auth/login` must stay tight to defend against
// credential-stuffing. Moving the decorator from class to handler gives
// each endpoint its own counter.
//
//   login                → 5/min   (credential stuffing defence)
//   refresh              → 60/min  (aggressive SDK token rotation)
//   impersonate          → 10/min  (admin tier; same bound as the old
//                                   class-wide rate, kept explicit)
//   me / logout /
//   stream-ticket /
//   revoke-impersonation → no per-endpoint decorator → app-wide default
//
// We assert per-handler metadata by reading the prototype method that
// `@Throttle` decorates (the throttler decorator writes through the
// method descriptor; see `@nestjs/throttler/dist/throttler.decorator.js`).
// ───────────────────────────────────────────────────────────────────────────
describe('AuthController per-endpoint throttle', () => {
    const limitOf = (method: Function) =>
        Reflect.getMetadata(THROTTLER_LIMIT + 'default', method);
    const ttlOf = (method: Function) =>
        Reflect.getMetadata(THROTTLER_TTL + 'default', method);

    it('login is decorated with 5 req / 60s (credential stuffing defence)', async () => {
        const { AuthController } = await import('../../auth/auth.controller');
        expect(limitOf(AuthController.prototype.login)).toBe(5);
        expect(ttlOf(AuthController.prototype.login)).toBe(60000);
    });

    it('refresh is decorated with 60 req / 60s (allows SDK token rotation)', async () => {
        const { AuthController } = await import('../../auth/auth.controller');
        expect(limitOf(AuthController.prototype.refresh)).toBe(60);
        expect(ttlOf(AuthController.prototype.refresh)).toBe(60000);
    });

    it('impersonate is decorated with 10 req / 60s (admin tier)', async () => {
        const { AuthController } = await import('../../auth/auth.controller');
        expect(limitOf(AuthController.prototype.impersonate)).toBe(10);
        expect(ttlOf(AuthController.prototype.impersonate)).toBe(60000);
    });

    it('me carries NO per-endpoint @Throttle (uses app-wide default)', async () => {
        const { AuthController } = await import('../../auth/auth.controller');
        expect(limitOf(AuthController.prototype.me)).toBeUndefined();
        expect(ttlOf(AuthController.prototype.me)).toBeUndefined();
    });

    it('logout carries NO per-endpoint @Throttle (uses app-wide default)', async () => {
        const { AuthController } = await import('../../auth/auth.controller');
        expect(limitOf(AuthController.prototype.logout)).toBeUndefined();
        expect(ttlOf(AuthController.prototype.logout)).toBeUndefined();
    });

    it('issueStreamTicket carries NO per-endpoint @Throttle (uses app-wide default)', async () => {
        const { AuthController } = await import('../../auth/auth.controller');
        expect(limitOf(AuthController.prototype.issueStreamTicket)).toBeUndefined();
        expect(ttlOf(AuthController.prototype.issueStreamTicket)).toBeUndefined();
    });

    it('revokeImpersonation carries NO per-endpoint @Throttle (uses app-wide default)', async () => {
        const { AuthController } = await import('../../auth/auth.controller');
        expect(limitOf(AuthController.prototype.revokeImpersonation)).toBeUndefined();
        expect(ttlOf(AuthController.prototype.revokeImpersonation)).toBeUndefined();
    });
});
