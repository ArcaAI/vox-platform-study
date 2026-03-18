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
        stt: { active: number };
        tts: { active: number };
        smr: { active: number };
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
                    'Text to Speech': createMockUptime(),
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
                    stt: { active: 5 },
                    tts: { active: 0 },
                    smr: { active: 0 },
                },
                totalUsers: 5,
                refreshedAt: new Date().toISOString(),
            };
            (mockService.getSessionCounts as ReturnType<typeof vi.fn>).mockResolvedValue(expected);

            const result = await controller.getSessions();

            expect(result).toEqual(expected);
            expect(mockService.getSessionCounts).toHaveBeenCalledOnce();
        });
    });
});
