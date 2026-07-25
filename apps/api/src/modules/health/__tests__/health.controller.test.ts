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

// Stubbed IConfigService so the controller's
// `downstreamServices` array can resolve URLs the same way as production
// (env-or-fallback at bootstrap, frozen at construction).
const createMockConfigService = () => ({
    getConfigValue: vi.fn((key: string) => {
        const map: Record<string, string> = {
            SMR_URL: 'http://localhost:8862',
            NLP_URL: 'http://localhost:8864',
            STT_URL: 'http://localhost:8861',
            TTS_URL: 'http://localhost:8867',
            GUARDRAIL_URL: 'http://localhost:8863',
            HARNESS_URL: 'http://localhost:8866',
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
        const smrHealthy = { data: { status: 'healthy', service: 'smr', version: '2.0.0', uptime_seconds: 200, timestamp: '2026-03-02T00:00:00Z', checks: {} } };
        const nlpHealthy = { data: { status: 'healthy', service: 'nlp', version: '1.0.0', uptime_seconds: 300, timestamp: '2026-03-02T00:00:00Z', checks: {} } };
        const sttHealthy = { data: { status: 'healthy', service: 'stt', version: '1.0.0', uptime_seconds: 400, timestamp: '2026-03-02T00:00:00Z', checks: {} } };
        const ttsHealthy = { data: { status: 'healthy', service: 'tts', version: '1.0.0', uptime_seconds: 450, timestamp: '2026-03-02T00:00:00Z', checks: {} } };
        const guardrailHealthy = { data: { status: 'healthy', service: 'guardrail', version: '1.0.0', uptime_seconds: 500, timestamp: '2026-03-02T00:00:00Z', checks: {} } };
        const harnessHealthy = { data: { status: 'healthy', service: 'harness', version: '0.1.0', uptime_seconds: 600, timestamp: '2026-03-02T00:00:00Z', checks: {} } };

        it('should return health status for all 6 downstream services', async () => {
            mockHttpService.axiosRef.get
                .mockResolvedValueOnce(smrHealthy)
                .mockResolvedValueOnce(nlpHealthy)
                .mockResolvedValueOnce(sttHealthy)
                .mockResolvedValueOnce(ttsHealthy)
                .mockResolvedValueOnce(guardrailHealthy)
                .mockResolvedValueOnce(harnessHealthy);

            const result = await controller.checkServices();

            expect(result.status).toBe('healthy');
            expect(result.services).toHaveProperty('smr');
            expect(result.services).toHaveProperty('nlp');
            expect(result.services).toHaveProperty('stt');
            expect(result.services).toHaveProperty('tts');
            expect(result.services).toHaveProperty('guardrail');
            expect(result.services).toHaveProperty('harness');
            expect(result.services.smr.status).toBe('healthy');
            expect(result.services.nlp.status).toBe('healthy');
            expect(result.services.stt.status).toBe('healthy');
            expect(result.services.tts.status).toBe('healthy');
            expect(result.services.guardrail.status).toBe('healthy');
            expect(result.services.harness.status).toBe('healthy');
        });

        it('should return degraded when some services are down', async () => {
            mockHttpService.axiosRef.get
                .mockResolvedValueOnce(smrHealthy)
                .mockRejectedValueOnce(new Error('ECONNREFUSED'))
                .mockResolvedValueOnce(sttHealthy)
                .mockResolvedValueOnce(ttsHealthy)
                .mockResolvedValueOnce(guardrailHealthy)
                .mockResolvedValueOnce(harnessHealthy);

            const result = await controller.checkServices();

            expect(result.status).toBe('degraded');
            expect(result.services.smr.status).toBe('healthy');
            expect(result.services.nlp.status).toBe('down');
            expect(result.services.stt.status).toBe('healthy');
            expect(result.services.tts.status).toBe('healthy');
            expect(result.services.guardrail.status).toBe('healthy');
            expect(result.services.harness.status).toBe('healthy');
        });

        it('should return unhealthy when all services are down', async () => {
            mockHttpService.axiosRef.get.mockRejectedValue(new Error('ECONNREFUSED'));

            const result = await controller.checkServices();

            expect(result.status).toBe('unhealthy');
            expect(result.services.smr.status).toBe('down');
            expect(result.services.nlp.status).toBe('down');
            expect(result.services.stt.status).toBe('down');
            expect(result.services.tts.status).toBe('down');
            expect(result.services.guardrail.status).toBe('down');
            expect(result.services.harness.status).toBe('down');
        });

        it('should include timestamp in response', async () => {
            mockHttpService.axiosRef.get.mockResolvedValue(smrHealthy);

            const result = await controller.checkServices();

            expect(result.timestamp).toBeDefined();
            expect(new Date(result.timestamp).getTime()).not.toBeNaN();
        });

        it('should include service-name response data from healthy services (sanitised — no version)', async () => {
            mockHttpService.axiosRef.get
                .mockResolvedValueOnce(smrHealthy)
                .mockResolvedValueOnce(nlpHealthy)
                .mockResolvedValueOnce(sttHealthy)
                .mockResolvedValueOnce(ttsHealthy)
                .mockResolvedValueOnce(guardrailHealthy)
                .mockResolvedValueOnce(harnessHealthy);

            const result = await controller.checkServices();

            // Version and checks are stripped
            // from the public response to avoid leaking downstream service
            // versions / internal probe details.
            expect(result.services.smr.service).toBe('Summarization');
            expect(result.services.guardrail.service).toBe('Guardrail');
            expect(result.services.smr).not.toHaveProperty('version');
            expect(result.services.guardrail).not.toHaveProperty('version');
        });

        it('should include error message for down services', async () => {
            mockHttpService.axiosRef.get
                .mockResolvedValueOnce(smrHealthy)
                .mockRejectedValueOnce(new Error('Connection refused'))
                .mockResolvedValueOnce(sttHealthy)
                .mockResolvedValueOnce(guardrailHealthy)
                .mockResolvedValueOnce(harnessHealthy);

            const result = await controller.checkServices();

            expect(result.services.nlp.error).toBe('Connection refused');
        });

        it('should call correct health endpoints for each service', async () => {
            mockHttpService.axiosRef.get.mockResolvedValue(smrHealthy);

            await controller.checkServices();

            const calledUrls = mockHttpService.axiosRef.get.mock.calls.map((c: any[]) => c[0]);
            expect(calledUrls).toHaveLength(6);
            expect(calledUrls[0]).toMatch(/localhost:8862\/api\/v1\/health$/);
            expect(calledUrls[1]).toMatch(/localhost:8864\/api\/v1\/health$/);
            expect(calledUrls[2]).toMatch(/localhost:8861\/api\/v1\/health$/);
            expect(calledUrls[3]).toMatch(/localhost:8867\/api\/v1\/health$/);
            // Guardrail mounts health under /api (not /api/v1).
            expect(calledUrls[4]).toMatch(/localhost:8863\/api\/health$/);
            expect(calledUrls[5]).toMatch(/localhost:8866\/api\/v1\/health$/);
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
            expect(result.service).toBe('Summarization');
            expect(result.duration_ms).toBeGreaterThanOrEqual(0);
            // Version + checks are stripped before
            // returning to the client. Full
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

            const result = await controller.checkServiceByKey('guardrail');

            expect(result.status).toBe('down');
            expect(result.service).toBe('Guardrail');
            expect(result.error).toBeDefined();
        });

        it('should accept all five valid service keys', async () => {
            for (const key of ['smr', 'nlp', 'stt', 'guardrail', 'harness']) {
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
    // Surface hardening for /health/services{/:key}
    //   - /services and /services/:key require @Authorize()
    //   - Response strips `version` and `checks` from each service entry
    //   - Class-level throttle: { limit: 30, ttl: 60000 }
    //   - /live, /ready, /startup, / remain public (no @Authorize)
    // ─────────────────────────────────────────────────────────────────
    describe('/health surface hardening', () => {
        it('declares an @Authorize() decorator on checkServices() (AC-15: C-8 fix)', () => {
            const required = Reflect.getMetadata(
                REQUIRED_PERMISSIONS_KEY,
                ApiHealthController.prototype.checkServices,
            );
            // @Authorize(...) sets a RequiredPermission[] on the handler. This
            // is the concrete admin gate (asserted exactly
            // in the block below); here we only check the gate exists.
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
    // Admin-gate /health/services{/:key}
    //   Gated to `@CanAny(['manage','all'], ['read','TenantTelemetry'])` so a
    //   tenant-admin with the seeded read:TenantTelemetry rule can read
    //   downstream service health, while a plain doctor (neither permission)
    //   still gets 403. Mode is OR. The k8s probes (/live, /ready, /startup, /)
    //   stay public.
    // ─────────────────────────────────────────────────────────────────
    describe('admin-gate /health/services', () => {
        const PERMISSION_MODE_KEY = 'permission_mode';

        it('accepts EITHER `manage all` OR `read TenantTelemetry` on checkServices()', () => {
            const required = Reflect.getMetadata(
                REQUIRED_PERMISSIONS_KEY,
                ApiHealthController.prototype.checkServices,
            );
            const mode = Reflect.getMetadata(PERMISSION_MODE_KEY, ApiHealthController.prototype.checkServices);
            expect(required).toEqual([
                { action: 'manage', subject: 'all' },
                { action: 'read', subject: 'TenantTelemetry' },
            ]);
            expect(mode).toBe('OR');
        });

        it('accepts EITHER `manage all` OR `read TenantTelemetry` on checkServiceByKey()', () => {
            const required = Reflect.getMetadata(
                REQUIRED_PERMISSIONS_KEY,
                ApiHealthController.prototype.checkServiceByKey,
            );
            const mode = Reflect.getMetadata(PERMISSION_MODE_KEY, ApiHealthController.prototype.checkServiceByKey);
            expect(required).toEqual([
                { action: 'manage', subject: 'all' },
                { action: 'read', subject: 'TenantTelemetry' },
            ]);
            expect(mode).toBe('OR');
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
