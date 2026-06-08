/**
 * MonitoringController Unit Tests
 *
 * Verifies the thin controller delegates to IServiceHealthMonitoringService
 * and correctly handles the NotFoundException for unknown services.
 *
 * Uses a local test class mirroring controller logic to avoid @arcaai/applications
 * circular dependency issues (same pattern as consultation.controller.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';

// ============================================================================
// Types mirroring production interfaces
// ============================================================================

interface HeartbeatRecord {
    timestamp: string;
    status: 'up' | 'down';
    responseTime: number;
}

type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

interface ServiceUptime {
    status: ServiceStatus;
    uptime: number;
    responseTime: number;
    lastCheck: string;
    heartbeats: HeartbeatRecord[];
}

interface UptimeResponse {
    services: Record<string, ServiceUptime>;
    refreshedAt: string;
}

interface SessionsResponse {
    services: {
        smr: { active: number };
        stt: { active: number };
        nlp: { active: number };
        guardrail: { active: number };
        harness: { active: number };
    };
    totalUsers: number;
    refreshedAt: string;
}

interface IServiceHealthMonitoringService {
    getUptime(): Promise<UptimeResponse>;
    getServiceUptime(serviceName: string): Promise<ServiceUptime | null>;
    getHeartbeatHistory(serviceName: string): Promise<HeartbeatRecord[]>;
    getSessionCounts(): Promise<SessionsResponse>;
}

// ============================================================================
// Test controller mirroring production logic
// ============================================================================

class TestMonitoringController {
    constructor(
        private readonly monitoringService: IServiceHealthMonitoringService,
    ) {}

    async getUptime(): Promise<UptimeResponse> {
        return this.monitoringService.getUptime();
    }

    async getServiceUptime(service: string): Promise<ServiceUptime> {
        const result = await this.monitoringService.getServiceUptime(service);
        if (!result) {
            throw new NotFoundException(`Service '${service}' not found`);
        }
        return result;
    }

    async getHeartbeats(service: string): Promise<HeartbeatRecord[]> {
        return this.monitoringService.getHeartbeatHistory(service);
    }

    async getSessions(): Promise<SessionsResponse> {
        return this.monitoringService.getSessionCounts();
    }
}

// ============================================================================
// Mock factories
// ============================================================================

const createMockMonitoringService = (): IServiceHealthMonitoringService => ({
    getUptime: vi.fn(),
    getServiceUptime: vi.fn(),
    getHeartbeatHistory: vi.fn(),
    getSessionCounts: vi.fn(),
});

function createMockUptime(overrides: Partial<ServiceUptime> = {}): ServiceUptime {
    return {
        status: 'healthy',
        uptime: 99.5,
        responseTime: 42,
        lastCheck: new Date().toISOString(),
        heartbeats: [],
        ...overrides,
    };
}

// ============================================================================
// Tests
// ============================================================================

describe('MonitoringController', () => {
    let controller: TestMonitoringController;
    let mockService: ReturnType<typeof createMockMonitoringService>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockService = createMockMonitoringService();
        controller = new TestMonitoringController(mockService);
    });

    describe('getUptime', () => {
        it('should delegate to monitoringService.getUptime', async () => {
            const expected: UptimeResponse = {
                services: {
                    'Speech to Text': createMockUptime(),
                    Guardrail: createMockUptime(),
                    Summarization: createMockUptime(),
                },
                refreshedAt: new Date().toISOString(),
            };
            (mockService.getUptime as ReturnType<typeof vi.fn>).mockResolvedValue(expected);

            const result = await controller.getUptime();

            expect(result).toEqual(expected);
            expect(mockService.getUptime).toHaveBeenCalledOnce();
        });
    });

    describe('getServiceUptime', () => {
        it('should return uptime for a known service', async () => {
            const expected = createMockUptime({ status: 'healthy', uptime: 100 });
            (mockService.getServiceUptime as ReturnType<typeof vi.fn>).mockResolvedValue(expected);

            const result = await controller.getServiceUptime('stt');

            expect(result).toEqual(expected);
            expect(mockService.getServiceUptime).toHaveBeenCalledWith('stt');
        });

        it('should throw NotFoundException for unknown service', async () => {
            (mockService.getServiceUptime as ReturnType<typeof vi.fn>).mockResolvedValue(null);

            await expect(controller.getServiceUptime('nonexistent')).rejects.toThrow(NotFoundException);
        });

        it('should include service name in the NotFoundException message', async () => {
            (mockService.getServiceUptime as ReturnType<typeof vi.fn>).mockResolvedValue(null);

            await expect(controller.getServiceUptime('foo')).rejects.toThrow(
                "Service 'foo' not found",
            );
        });
    });

    describe('getHeartbeats', () => {
        it('should delegate to monitoringService.getHeartbeatHistory', async () => {
            const expected: HeartbeatRecord[] = [
                { timestamp: new Date().toISOString(), status: 'up', responseTime: 50 },
            ];
            (mockService.getHeartbeatHistory as ReturnType<typeof vi.fn>).mockResolvedValue(expected);

            const result = await controller.getHeartbeats('stt');

            expect(result).toEqual(expected);
            expect(mockService.getHeartbeatHistory).toHaveBeenCalledWith('stt');
        });

        it('should return empty array when no heartbeats exist', async () => {
            (mockService.getHeartbeatHistory as ReturnType<typeof vi.fn>).mockResolvedValue([]);

            const result = await controller.getHeartbeats('stt');

            expect(result).toEqual([]);
        });
    });

    describe('getSessions', () => {
        it('should delegate to monitoringService.getSessionCounts', async () => {
            const expected: SessionsResponse = {
                services: {
                    smr: { active: 0 },
                    stt: { active: 5 },
                    nlp: { active: 0 },
                    guardrail: { active: 0 },
                    harness: { active: 0 },
                },
                totalUsers: 5,
                refreshedAt: new Date().toISOString(),
            };
            (mockService.getSessionCounts as ReturnType<typeof vi.fn>).mockResolvedValue(expected);

            const result = await controller.getSessions();

            expect(result).toEqual(expected);
            expect(mockService.getSessionCounts).toHaveBeenCalledOnce();
        });

        // Sessions cover the real downstream services so the surface stays
        // aligned with uptime/health.
        it('returns stt, nlp, guardrail and harness session counts alongside smr', async () => {
            const expected: SessionsResponse = {
                services: {
                    smr: { active: 0 },
                    stt: { active: 0 },
                    nlp: { active: 0 },
                    guardrail: { active: 0 },
                    harness: { active: 0 },
                },
                totalUsers: 0,
                refreshedAt: new Date().toISOString(),
            };
            (mockService.getSessionCounts as ReturnType<typeof vi.fn>).mockResolvedValue(expected);

            const result = await controller.getSessions();

            expect(result.services.stt).toEqual({ active: 0 });
            expect(result.services.nlp).toEqual({ active: 0 });
            expect(result.services.guardrail).toEqual({ active: 0 });
            expect(result.services.harness).toEqual({ active: 0 });
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// TASK-336 OB-12 — admin-gate the monitoring surface
//   Pre-OB-12 the controller carried a bare @Authorize() (any authenticated
//   caller — a plain doctor could read ops uptime/sessions). OB-12 tightens
//   the whole controller to the SUPER_ADMIN `manage all` gate the other
//   ops/admin surfaces use (e.g. RateLimitAdminController).
//
//   Asserted against the REAL controller via dynamic import (the suite above
//   uses a local mirror to dodge the @arcaai/applications circular dep; the
//   metadata check needs the actual decorated class).
// ─────────────────────────────────────────────────────────────────────────
describe('TASK-336 OB-12 — monitoring admin-gating', () => {
    const REQUIRED_PERMISSIONS_KEY = 'required_permissions';

    it('requires `manage all` at the controller level', async () => {
        const { MonitoringController } = await import('../monitoring.controller');
        const required = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, MonitoringController);
        expect(required).toEqual([{ action: 'manage', subject: 'all' }]);
    });
});
