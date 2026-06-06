/**
 * ApiHealthController Unit Tests
 *
 * Tests for consolidated health endpoints including /health/services
 * which proxies health checks to all downstream Python microservices.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiHealthController } from '../health.controller';
import { HttpService } from '@nestjs/axios';

const REQUIRED_PERMISSIONS_KEY = 'required_permissions';
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

const createMockShutdownService = (overrides?: { isReady?: boolean; isShuttingDown?: boolean }) => ({
    isReady: overrides?.isReady ?? true,
    isShuttingDown: overrides?.isShuttingDown ?? false,
});

const createMockHttpService = () => ({
    axiosRef: {
        get: vi.fn(),
    },
});

// TASK-310 E-5 (AC-5): stubbed IConfigService so the controller's
// `downstreamServices` array can resolve URLs the same way as production
// (env-or-fallback at bootstrap, frozen at construction).
const createMockConfigService = () => ({
    getConfigValue: vi.fn((key: string) => {
        const map: Record<string, string> = {
            TTS_URL: 'http://localhost:8863',
            SMR_URL: 'http://localhost:8862',
            NLP_URL: 'http://localhost:8864',
            STT_V2_URL: 'http://localhost:8861',
        };
        return map[key];
    }),
});

describe('ApiHealthController', () => {
    let controller: ApiHealthController;
    let mockShutdownService: ReturnType<typeof createMockShutdownService>;
    let mockHttpService: ReturnType<typeof createMockHttpService>;
    let mockConfigService: ReturnType<typeof createMockConfigService>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockShutdownService = createMockShutdownService();
        mockHttpService = createMockHttpService();
        mockConfigService = createMockConfigService();
        controller = new ApiHealthController(mockShutdownService as any, mockHttpService as any, mockConfigService as any);
    });

    describe('GET /health/live', () => {
        it('should return healthy status', () => {
            expect(controller.liveness()).toEqual({ status: 'healthy' });
        });
    });

    describe('GET /health/ready', () => {
        it('should return healthy when service is ready', () => {
            expect(controller.readiness()).toEqual({ status: 'healthy' });
        });

        it('should throw 503 when service is shutting down', () => {
            mockShutdownService = createMockShutdownService({ isReady: false, isShuttingDown: true });
            controller = new ApiHealthController(mockShutdownService as any, mockHttpService as any, mockConfigService as any);

            expect(() => controller.readiness()).toThrow();
        });

        it('should throw 503 when service is not ready', () => {
            mockShutdownService = createMockShutdownService({ isReady: false });
            controller = new ApiHealthController(mockShutdownService as any, mockHttpService as any, mockConfigService as any);

            expect(() => controller.readiness()).toThrow();
        });
    });

    describe('GET /health/startup', () => {
        it('should return healthy when service is ready', () => {
            expect(controller.startup()).toEqual({ status: 'healthy' });
        });

        it('should throw 503 when service is initializing', () => {
            mockShutdownService = createMockShutdownService({ isReady: false, isShuttingDown: false });
            controller = new ApiHealthController(mockShutdownService as any, mockHttpService as any, mockConfigService as any);

            expect(() => controller.startup()).toThrow();
        });
    });

    describe('GET /health', () => {
        it('should return detailed health check with status healthy when ready', () => {
            const result = controller.check();

            expect(result.status).toBe('healthy');
            expect(result.service).toBe('api');
            expect(result.version).toBeDefined();
            expect(result.uptime_seconds).toBeGreaterThanOrEqual(0);
            expect(result.timestamp).toBeDefined();
            expect(result.checks.process.status).toBe('healthy');
        });

        it('should return unhealthy when shutting down', () => {
            mockShutdownService = createMockShutdownService({ isReady: false, isShuttingDown: true });
            controller = new ApiHealthController(mockShutdownService as any, mockHttpService as any, mockConfigService as any);

            const result = controller.check();
            expect(result.status).toBe('unhealthy');
        });

        it('should return degraded when not ready and not shutting down', () => {
            mockShutdownService = createMockShutdownService({ isReady: false, isShuttingDown: false });
            controller = new ApiHealthController(mockShutdownService as any, mockHttpService as any, mockConfigService as any);

            const result = controller.check();
            expect(result.status).toBe('degraded');
        });
    });

    describe('GET /health/services', () => {
        const ttsHealthy = { data: { status: 'healthy', service: 'tts', version: '1.0.0', uptime_seconds: 100, timestamp: '2026-03-02T00:00:00Z', checks: {} } };
        const smrHealthy = { data: { status: 'healthy', service: 'smr', version: '2.0.0', uptime_seconds: 200, timestamp: '2026-03-02T00:00:00Z', checks: {} } };
        const nlpHealthy = { data: { status: 'healthy', service: 'nlp', version: '1.0.0', uptime_seconds: 300, timestamp: '2026-03-02T00:00:00Z', checks: {} } };
        const sttHealthy = { data: { status: 'healthy', service: 'stt-v2', version: '1.0.0', uptime_seconds: 400, timestamp: '2026-03-02T00:00:00Z', checks: {} } };

        it('should return health status for all 4 downstream services', async () => {
            mockHttpService.axiosRef.get
                .mockResolvedValueOnce(ttsHealthy)
                .mockResolvedValueOnce(smrHealthy)
                .mockResolvedValueOnce(nlpHealthy)
                .mockResolvedValueOnce(sttHealthy);

            const result = await controller.checkServices();

            expect(result.status).toBe('healthy');
            expect(result.services).toHaveProperty('tts');
            expect(result.services).toHaveProperty('smr');
            expect(result.services).toHaveProperty('nlp');
            expect(result.services).toHaveProperty('stt');
            expect(result.services.tts.status).toBe('healthy');
            expect(result.services.smr.status).toBe('healthy');
            expect(result.services.nlp.status).toBe('healthy');
            expect(result.services.stt.status).toBe('healthy');
        });

        it('should return degraded when some services are down', async () => {
            mockHttpService.axiosRef.get
                .mockResolvedValueOnce(ttsHealthy)
                .mockRejectedValueOnce(new Error('ECONNREFUSED'))
                .mockResolvedValueOnce(nlpHealthy)
                .mockResolvedValueOnce(sttHealthy);

            const result = await controller.checkServices();

            expect(result.status).toBe('degraded');
            expect(result.services.tts.status).toBe('healthy');
            expect(result.services.smr.status).toBe('down');
            expect(result.services.nlp.status).toBe('healthy');
            expect(result.services.stt.status).toBe('healthy');
        });

        it('should return unhealthy when all services are down', async () => {
            mockHttpService.axiosRef.get.mockRejectedValue(new Error('ECONNREFUSED'));

            const result = await controller.checkServices();

            expect(result.status).toBe('unhealthy');
            expect(result.services.tts.status).toBe('down');
            expect(result.services.smr.status).toBe('down');
            expect(result.services.nlp.status).toBe('down');
            expect(result.services.stt.status).toBe('down');
        });

        it('should include timestamp in response', async () => {
            mockHttpService.axiosRef.get.mockResolvedValue(ttsHealthy);

            const result = await controller.checkServices();

            expect(result.timestamp).toBeDefined();
            expect(new Date(result.timestamp).getTime()).not.toBeNaN();
        });

        it('should include service-name response data from healthy services (sanitised — no version)', async () => {
            mockHttpService.axiosRef.get
                .mockResolvedValueOnce(ttsHealthy)
                .mockResolvedValueOnce(smrHealthy)
                .mockResolvedValueOnce(nlpHealthy)
                .mockResolvedValueOnce(sttHealthy);

            const result = await controller.checkServices();

            // TASK-307 W5.1 / AC-15 / E-3 — version and checks are stripped
            // from the public response to avoid leaking downstream service
            // versions / internal probe details (per audit finding C-8).
            expect(result.services.tts.service).toBe('tts');
            expect(result.services.smr.service).toBe('smr');
            expect(result.services.tts).not.toHaveProperty('version');
            expect(result.services.smr).not.toHaveProperty('version');
        });

        it('should include error message for down services', async () => {
            mockHttpService.axiosRef.get
                .mockResolvedValueOnce(ttsHealthy)
                .mockRejectedValueOnce(new Error('Connection refused'))
                .mockResolvedValueOnce(nlpHealthy)
                .mockResolvedValueOnce(sttHealthy);

            const result = await controller.checkServices();

            expect(result.services.smr.error).toBe('Connection refused');
        });

        it('should call correct health endpoints for each service', async () => {
            mockHttpService.axiosRef.get.mockResolvedValue(ttsHealthy);

            await controller.checkServices();

            const calledUrls = mockHttpService.axiosRef.get.mock.calls.map((c: any[]) => c[0]);
            expect(calledUrls).toHaveLength(4);
            expect(calledUrls[0]).toMatch(/localhost:8863\/api\/v1\/health$/);
            expect(calledUrls[1]).toMatch(/localhost:8862\/api\/v1\/health$/);
            expect(calledUrls[2]).toMatch(/localhost:8864\/api\/v1\/health$/);
            expect(calledUrls[3]).toMatch(/localhost:8861\/api\/v1\/health$/);
        });
    });

    describe('GET /health/services/:serviceKey', () => {
        const smrHealthy = {
            data: {
                status: 'healthy',
                service: 'smr',
                version: '2.0.0',
                uptime_seconds: 200,
                timestamp: '2026-03-02T00:00:00Z',
                checks: { gpu: { status: 'healthy' } },
            },
        };

        it('should return sanitised structured health for a valid service key (no version / no checks)', async () => {
            mockHttpService.axiosRef.get.mockResolvedValueOnce(smrHealthy);

            const result = await controller.checkServiceByKey('smr');

            expect(result.status).toBe('healthy');
            expect(result.service).toBe('smr');
            expect(result.duration_ms).toBeGreaterThanOrEqual(0);
            // TASK-307 W5.1 / AC-15 — version + checks are stripped before
            // returning to the client (audit C-8 / E-3 / D-11). Full
            // detail remains in server logs only.
            expect(result).not.toHaveProperty('version');
            expect(result).not.toHaveProperty('checks');
        });

        it('should return structured down status when service is unreachable', async () => {
            mockHttpService.axiosRef.get.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:8862'));

            const result = await controller.checkServiceByKey('smr');

            expect(result.status).toBe('down');
            expect(result.service).toBe('Summarization');
            expect(result.error).toContain('ECONNREFUSED');
        });

        it('should return structured down status on timeout', async () => {
            const timeoutErr = new Error('timeout of 5000ms exceeded');
            (timeoutErr as any).code = 'ECONNABORTED';
            mockHttpService.axiosRef.get.mockRejectedValueOnce(timeoutErr);

            const result = await controller.checkServiceByKey('smr');

            expect(result.status).toBe('down');
            expect(result.error).toContain('timeout');
        });

        it('should throw NotFoundException for unknown service key', async () => {
            await expect(controller.checkServiceByKey('unknown')).rejects.toThrow();
        });

        it('should never throw 500/502 when a known service is down', async () => {
            mockHttpService.axiosRef.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

            const result = await controller.checkServiceByKey('tts');

            expect(result.status).toBe('down');
            expect(result.service).toBe('Text to Speech');
            expect(result.error).toBeDefined();
        });

        it('should accept all four valid service keys', async () => {
            for (const key of ['tts', 'smr', 'nlp', 'stt']) {
                mockHttpService.axiosRef.get.mockResolvedValueOnce(smrHealthy);
                const result = await controller.checkServiceByKey(key);
                expect(result.status).toBeDefined();
            }
        });

        it('should include timestamp in response', async () => {
            mockHttpService.axiosRef.get.mockResolvedValueOnce(smrHealthy);

            const result = await controller.checkServiceByKey('smr');

            expect(result.timestamp).toBeDefined();
            expect(new Date(result.timestamp).getTime()).not.toBeNaN();
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // TASK-307 W5.1 — Surface hardening for /health/services{/:key}
    //   AC-15 closes audit findings:
    //     C-8  (/health/services unauth + leaks)
    //     D-11 (Health throttle 300/min too generous)
    //     E-3  (Health leaks downstream version)
    //
    //   - /services and /services/:key now require @Authorize()
    //   - Response strips `version` and `checks` from each service entry
    //   - Class-level throttle lowered to { limit: 30, ttl: 60000 }
    //   - /live, /ready, /startup, / remain public (no @Authorize)
    // ─────────────────────────────────────────────────────────────────
    describe('TASK-307 W5.1 — /health surface hardening (AC-15)', () => {
        it('declares an @Authorize() decorator on checkServices() (AC-15: C-8 fix)', () => {
            const required = Reflect.getMetadata(
                REQUIRED_PERMISSIONS_KEY,
                ApiHealthController.prototype.checkServices,
            );
            // @Authorize(...) sets a RequiredPermission[] on the handler. Post
            // TASK-336 OB-12 this is the concrete admin gate (asserted exactly
            // in the OB-12 block below); here we only check the gate exists.
            expect(required).toBeDefined();
            expect(Array.isArray(required)).toBe(true);
        });

        it('declares an @Authorize() decorator on checkServiceByKey() (AC-15: C-8 fix)', () => {
            const required = Reflect.getMetadata(
                REQUIRED_PERMISSIONS_KEY,
                ApiHealthController.prototype.checkServiceByKey,
            );
            expect(required).toBeDefined();
            expect(Array.isArray(required)).toBe(true);
        });

        it('does NOT declare @Authorize() on liveness() — probe stays public (AC-15)', () => {
            const required = Reflect.getMetadata(
                REQUIRED_PERMISSIONS_KEY,
                ApiHealthController.prototype.liveness,
            );
            expect(required).toBeUndefined();
        });

        it('does NOT declare @Authorize() on readiness() — probe stays public (AC-15)', () => {
            const required = Reflect.getMetadata(
                REQUIRED_PERMISSIONS_KEY,
                ApiHealthController.prototype.readiness,
            );
            expect(required).toBeUndefined();
        });

        it('does NOT declare @Authorize() on startup() — probe stays public (AC-15)', () => {
            const required = Reflect.getMetadata(
                REQUIRED_PERMISSIONS_KEY,
                ApiHealthController.prototype.startup,
            );
            expect(required).toBeUndefined();
        });

        it('lowers the class-level throttle to 30 req/60s (AC-15: D-11 fix)', () => {
            const limit = Reflect.getMetadata(THROTTLER_LIMIT + 'default', ApiHealthController);
            const ttl = Reflect.getMetadata(THROTTLER_TTL + 'default', ApiHealthController);
            expect(limit).toBe(30);
            expect(ttl).toBe(60000);
        });

        it('strips `version` and `checks` from the public services payload (AC-15: E-3 fix)', async () => {
            const smrHealthy = {
                data: {
                    status: 'healthy',
                    service: 'smr',
                    version: '2.0.0',
                    uptime_seconds: 200,
                    checks: { gpu: { status: 'healthy' } },
                },
            };
            mockHttpService.axiosRef.get.mockResolvedValue(smrHealthy);

            const result = await controller.checkServices();

            for (const key of Object.keys(result.services)) {
                expect(result.services[key]).not.toHaveProperty('version');
                expect(result.services[key]).not.toHaveProperty('checks');
            }
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // TASK-336 OB-12 — admin-gate /health/services{/:key}
    //   Pre-OB-12 these carried @Authorize() (any authenticated caller —
    //   a plain doctor could read downstream ops health). OB-12 tightens
    //   them to the same SUPER_ADMIN gate the other ops/admin surfaces use
    //   (`manage all`, e.g. RateLimitAdminController). The k8s probes
    //   (/live, /ready, /startup, /) stay public.
    // ─────────────────────────────────────────────────────────────────
    describe('TASK-336 OB-12 — admin-gate /health/services', () => {
        it('requires `manage all` on checkServices()', () => {
            const required = Reflect.getMetadata(
                REQUIRED_PERMISSIONS_KEY,
                ApiHealthController.prototype.checkServices,
            );
            expect(required).toEqual([{ action: 'manage', subject: 'all' }]);
        });

        it('requires `manage all` on checkServiceByKey()', () => {
            const required = Reflect.getMetadata(
                REQUIRED_PERMISSIONS_KEY,
                ApiHealthController.prototype.checkServiceByKey,
            );
            expect(required).toEqual([{ action: 'manage', subject: 'all' }]);
        });

        it('keeps the k8s probes public (no permissions on liveness/readiness/startup)', () => {
            for (const method of ['liveness', 'readiness', 'startup'] as const) {
                const required = Reflect.getMetadata(
                    REQUIRED_PERMISSIONS_KEY,
                    ApiHealthController.prototype[method],
                );
                expect(required).toBeUndefined();
            }
        });
    });
});
