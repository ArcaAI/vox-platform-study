/**
 * STT v1 Health Check Removal Verification Tests (TASK-210 Phase 1)
 *
 * Verifies that the ServiceHealthMonitoringService no longer monitors
 * the legacy STT v1 service (port 5003, STT_URL). It now monitors
 * STT v2 at port 8861 instead.
 *
 * These tests verify real service behavior through boundary mocks
 * (Redis, fetch) -- not mock behavior itself.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockRedisInstance = {
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue('OK'),
    expire: vi.fn().mockResolvedValue(1),
    lrange: vi.fn().mockResolvedValue([]),
};

vi.mock('ioredis', () => ({
    default: function MockRedis() {
        return mockRedisInstance;
    },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { ServiceHealthMonitoringService } from '../serviceHealthMonitoring.service';

const createMockConfigService = () => ({
    getRedisConfig: vi.fn().mockReturnValue({
        host: 'localhost',
        port: 6379,
        password: undefined,
    }),
    get: vi.fn(),
    getOrThrow: vi.fn(),
});

describe('STT v1 Health Check Removal (TASK-210 Phase 1)', () => {
    let service: ServiceHealthMonitoringService;

    beforeEach(async () => {
        mockRedisInstance.connect.mockReset().mockResolvedValue(undefined);
        mockRedisInstance.quit.mockReset().mockResolvedValue(undefined);
        mockRedisInstance.lpush.mockReset().mockResolvedValue(1);
        mockRedisInstance.ltrim.mockReset().mockResolvedValue('OK');
        mockRedisInstance.expire.mockReset().mockResolvedValue(1);
        mockRedisInstance.lrange.mockReset().mockResolvedValue([]);
        mockFetch.mockReset();
        mockFetch.mockResolvedValue({ ok: true });

        const mockConfigService = createMockConfigService();
        service = new ServiceHealthMonitoringService(mockConfigService as any);
        await service.onModuleInit();

        mockFetch.mockReset();
        mockRedisInstance.lpush.mockClear();
    });

    describe('service list after STT v1 removal', () => {
        it('should monitor SMR, NLP, STT v2, Guardrail, Harness (not STT v1)', async () => {
            mockRedisInstance.lrange.mockResolvedValue([]);

            const result = await service.getUptime();

            const serviceNames = Object.keys(result.services);
            expect(serviceNames).toHaveLength(6);
            expect(serviceNames).toContain('smr');
            expect(serviceNames).toContain('nlp');
            expect(serviceNames).toContain('stt');
            expect(serviceNames).toContain('tts');
            expect(serviceNames).toContain('guardrail');
            expect(serviceNames).toContain('harness');
        });

        it('should return uptime for STT v2 (Speech to Text)', async () => {
            mockRedisInstance.lrange.mockResolvedValue([]);
            const result = await service.getServiceUptime('stt');
            expect(result).not.toBeNull();
            expect(result!.status).toBe('unknown');
        });

        it('should still return uptime for Summarization', async () => {
            mockRedisInstance.lrange.mockResolvedValue([]);
            const result = await service.getServiceUptime('smr');
            expect(result).not.toBeNull();
            expect(result!.status).toBe('unknown');
        });

        it('should return uptime for Guardrail', async () => {
            mockRedisInstance.lrange.mockResolvedValue([]);
            const result = await service.getServiceUptime('guardrail');
            expect(result).not.toBeNull();
            expect(result!.status).toBe('unknown');
        });
    });

    describe('health check URLs should not include STT v1', () => {
        it('should perform health checks for all 6 services', async () => {
            mockFetch.mockResolvedValue({ ok: true });

            await service.performHealthChecks();

            expect(mockFetch).toHaveBeenCalledTimes(6);
        });

        it('should not call any STT v1 URL (port 5003)', async () => {
            mockFetch.mockResolvedValue({ ok: true });

            await service.performHealthChecks();

            const calledUrls = mockFetch.mock.calls.map((call: any[]) => call[0] as string);
            for (const url of calledUrls) {
                expect(url).not.toContain(':5003');
            }
        });

        // Guardrail mounts its health router under `/api`; the others use
        // `/api/v1/health` (mirrors the gateway health controller).
        it('should call all service health endpoints at /api(/v1)/health', async () => {
            mockFetch.mockResolvedValue({ ok: true });

            await service.performHealthChecks();

            const calledUrls = mockFetch.mock.calls.map((call: any[]) => call[0] as string);
            for (const url of calledUrls) {
                expect(url).toMatch(/\/api\/(v1\/)?health$/);
            }
        });
    });

    describe('getSessionCounts after STT v1 removal', () => {
        it('should not make any fetch calls', async () => {
            await service.getSessionCounts();
            expect(mockFetch).not.toHaveBeenCalled();
        });

        // Sessions expose an `stt` (STT v2) key alongside smr/nlp/guardrail/
        // harness for surface consistency. This does NOT reintroduce the
        // removed STT v1 *polling* (see "should not make any fetch calls"); the
        // count is a static placeholder produced without any network call.
        it('should include stt (STT v2) as a static, non-polled session count', async () => {
            const result = await service.getSessionCounts();
            expect(result.services).toHaveProperty('stt');
            expect(result.services.stt.active).toBe(0);
        });

        it('should return 0 totalUsers', async () => {
            const result = await service.getSessionCounts();
            expect(result.totalUsers).toBe(0);
        });

        it('should include smr, guardrail and harness with zero active counts', async () => {
            const result = await service.getSessionCounts();
            expect(result.services.smr.active).toBe(0);
            expect(result.services.guardrail.active).toBe(0);
            expect(result.services.harness.active).toBe(0);
        });

        it('should include a valid ISO refreshedAt timestamp', async () => {
            const result = await service.getSessionCounts();
            expect(result.refreshedAt).toBeDefined();
            expect(new Date(result.refreshedAt).toISOString()).toBe(result.refreshedAt);
        });
    });
});
