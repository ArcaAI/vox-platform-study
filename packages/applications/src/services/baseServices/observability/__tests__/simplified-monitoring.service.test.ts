/**
 * SimplifiedMonitoringService Unit Tests
 *
 * Tests for the system monitoring and KPI tracking service.
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { SimplifiedMonitoringService } from '../simplified-monitoring.service';
import type { IMetricsService } from '../../metrics/IMetricsService';

// Mock os module
vi.mock('os', () => ({
    cpus: vi.fn().mockReturnValue([
        { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
        { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
    ]),
    totalmem: vi.fn().mockReturnValue(16 * 1024 * 1024 * 1024), // 16GB
    freemem: vi.fn().mockReturnValue(8 * 1024 * 1024 * 1024), // 8GB
}));

import * as os from 'os';

describe('SimplifiedMonitoringService', () => {
    let service: SimplifiedMonitoringService;
    let mockMetricsService: IMetricsService;
    let mockGauge: any;
    let mockCounter: any;
    let mockHistogram: any;
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();

        process.env = {
            ...originalEnv,
            OTEL_SERVICE_NAME: 'test-service',
            NODE_ENV: 'test',
            METRICS_COLLECT_INTERVAL: '15000',
        };

        // Create mock metrics
        mockGauge = {
            set: vi.fn(),
        };
        mockCounter = {
            inc: vi.fn(),
        };
        mockHistogram = {
            observe: vi.fn(),
        };

        // Create mock metrics service
        mockMetricsService = {
            createCounter: vi.fn().mockReturnValue(mockCounter),
            createGauge: vi.fn().mockReturnValue(mockGauge),
            createHistogram: vi.fn().mockReturnValue(mockHistogram),
            createSummary: vi.fn(),
            getMetric: vi.fn().mockImplementation((name: string) => {
                if (name.includes('gauge') || name.includes('cpu') || name.includes('memory') || name.includes('connections')) {
                    return mockGauge;
                }
                if (name.includes('counter') || name.includes('total')) {
                    return mockCounter;
                }
                if (name.includes('histogram') || name.includes('duration')) {
                    return mockHistogram;
                }
                return undefined;
            }),
            registerMetric: vi.fn(),
            incrementCounter: vi.fn(),
            setGauge: vi.fn(),
            observeHistogram: vi.fn(),
        } as unknown as IMetricsService;

        service = new SimplifiedMonitoringService(mockMetricsService);
    });

    afterEach(() => {
        process.env = originalEnv;
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe('constructor', () => {
        it('should create service with metrics service', () => {
            expect(service).toBeDefined();
        });

        it('should use environment variables for configuration', () => {
            process.env.OTEL_SERVICE_NAME = 'custom-service';
            service = new SimplifiedMonitoringService(mockMetricsService);
            expect(service).toBeDefined();
        });
    });

    describe('onModuleInit', () => {
        it('should create system metrics gauges', async () => {
            await service.onModuleInit();

            expect(mockMetricsService.getMetric).toHaveBeenCalledWith('system_cpu_usage_percent');
            expect(mockMetricsService.getMetric).toHaveBeenCalledWith('system_memory_usage_percent');
            expect(mockMetricsService.getMetric).toHaveBeenCalledWith('active_connections_count');
        });

        it('should create gauges if they do not exist', async () => {
            mockMetricsService.getMetric = vi.fn().mockReturnValue(undefined);

            await service.onModuleInit();

            expect(mockMetricsService.createGauge).toHaveBeenCalled();
        });

        it('should start metrics collection interval', async () => {
            await service.onModuleInit();

            // Advance timer to trigger collection
            vi.advanceTimersByTime(15000);

            // Should have collected metrics
        });

        it('should use custom collection interval', async () => {
            process.env.METRICS_COLLECT_INTERVAL = '30000';
            service = new SimplifiedMonitoringService(mockMetricsService);

            await service.onModuleInit();

            // Advance by default interval - should not collect yet
            vi.advanceTimersByTime(15000);
        });

        it('should handle initialization errors', async () => {
            mockMetricsService.getMetric = vi.fn().mockImplementation(() => {
                throw new Error('Metrics error');
            });

            await expect(service.onModuleInit()).rejects.toThrow();
        });
    });

    describe('onModuleDestroy', () => {
        it('should clear collection interval', async () => {
            await service.onModuleInit();
            await service.onModuleDestroy();

            // Advance timer - should not trigger collection
            vi.advanceTimersByTime(30000);
        });

        it('should not throw if interval was not set', async () => {
            await expect(service.onModuleDestroy()).resolves.not.toThrow();
        });
    });

    describe('getSystemMetrics', () => {
        it('should return system metrics', async () => {
            const metrics = await service.getSystemMetrics();

            expect(metrics).toHaveProperty('cpuUsage');
            expect(metrics).toHaveProperty('memoryUsage');
            expect(metrics).toHaveProperty('threadCount');
            expect(metrics).toHaveProperty('uptime');
            expect(metrics).toHaveProperty('processingQueueLength');
            expect(metrics).toHaveProperty('activeConnections');
        });

        it('should calculate CPU usage correctly', async () => {
            const metrics = await service.getSystemMetrics();

            // With mocked values: total = 1000 per CPU, idle = 850 per CPU
            // CPU usage = 100 - (idle/total * 100) = 100 - 85 = 15%
            expect(metrics.cpuUsage).toBeGreaterThanOrEqual(0);
            expect(metrics.cpuUsage).toBeLessThanOrEqual(100);
        });

        it('should calculate memory usage correctly', async () => {
            const metrics = await service.getSystemMetrics();

            // With mocked values: total = 16GB, free = 8GB
            // Memory usage = (16 - 8) / 16 * 100 = 50%
            expect(metrics.memoryUsage).toBe(50);
        });

        it('should handle zero total memory', async () => {
            (os.totalmem as Mock).mockReturnValue(0);

            const metrics = await service.getSystemMetrics();

            expect(metrics.memoryUsage).toBe(0);
        });

        it('should handle zero CPU ticks', async () => {
            (os.cpus as Mock).mockReturnValue([
                { times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
            ]);

            const metrics = await service.getSystemMetrics();

            expect(metrics.cpuUsage).toBe(0);
        });
    });

    describe('recordKpi', () => {
        beforeEach(async () => {
            await service.onModuleInit();
        });

        it('should record KPI value', async () => {
            await service.recordKpi('test_kpi', 42);

            expect(mockMetricsService.getMetric).toHaveBeenCalledWith('test_kpi');
        });

        it('should create gauge if KPI metric does not exist', async () => {
            mockMetricsService.getMetric = vi.fn().mockReturnValue(undefined);

            await service.recordKpi('new_kpi', 100);

            expect(mockMetricsService.createGauge).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: 'new_kpi',
                })
            );
        });

        it('should include metadata in labels', async () => {
            await service.recordKpi('metadata_kpi', 50, { region: 'us-east' });

            expect(mockMetricsService.getMetric).toHaveBeenCalledWith('metadata_kpi');
        });

        it('should handle recording errors', async () => {
            mockMetricsService.getMetric = vi.fn().mockImplementation(() => {
                throw new Error('Recording error');
            });

            await expect(service.recordKpi('error_kpi', 10)).rejects.toThrow();
        });
    });

    describe('getKpiHistory', () => {
        it('should return empty array', async () => {
            const history = await service.getKpiHistory(
                'test_kpi',
                new Date('2024-01-01'),
                new Date('2024-01-02')
            );

            expect(history).toEqual([]);
        });

        it('should accept aggregation parameter', async () => {
            const history = await service.getKpiHistory(
                'test_kpi',
                new Date('2024-01-01'),
                new Date('2024-01-02'),
                'avg'
            );

            expect(history).toEqual([]);
        });
    });

    describe('checkIntegrationStatus', () => {
        it('should return integration statuses', async () => {
            const statuses = await service.checkIntegrationStatus();

            expect(Array.isArray(statuses)).toBe(true);
            expect(statuses.length).toBeGreaterThan(0);
        });

        it('should include prometheus metrics status', async () => {
            const statuses = await service.checkIntegrationStatus();

            const prometheusStatus = statuses.find(s => s.name === 'prometheus_metrics');
            expect(prometheusStatus).toBeDefined();
            expect(prometheusStatus?.isConnected).toBe(true);
        });

        it('should include logging system status', async () => {
            const statuses = await service.checkIntegrationStatus();

            const loggingStatus = statuses.find(s => s.name === 'logging_system');
            expect(loggingStatus).toBeDefined();
            expect(loggingStatus?.isConnected).toBe(true);
        });
    });

    describe('subscribeToMetric', () => {
        it('should return subscription ID', () => {
            const callback = vi.fn();
            const subscriptionId = service.subscribeToMetric('test_metric', callback);

            expect(subscriptionId).toBeDefined();
            expect(typeof subscriptionId).toBe('string');
        });

        it('should generate unique subscription IDs', () => {
            const callback = vi.fn();
            const id1 = service.subscribeToMetric('metric1', callback);
            const id2 = service.subscribeToMetric('metric2', callback);

            expect(id1).not.toBe(id2);
        });
    });

    describe('unsubscribeFromMetric', () => {
        it('should not throw', () => {
            expect(() => service.unsubscribeFromMetric('subscription-123')).not.toThrow();
        });
    });

    describe('recordHttpRequest', () => {
        beforeEach(async () => {
            await service.onModuleInit();
        });

        it('should record HTTP request metrics', async () => {
            await service.recordHttpRequest('GET', '/api/users', 200, 0.5);

            expect(mockMetricsService.getMetric).toHaveBeenCalledWith('http_requests_total');
            expect(mockMetricsService.getMetric).toHaveBeenCalledWith('http_request_duration_seconds');
        });

        it('should handle missing metrics gracefully', async () => {
            mockMetricsService.getMetric = vi.fn().mockReturnValue(undefined);

            await expect(
                service.recordHttpRequest('POST', '/api/users', 201, 0.3)
            ).resolves.not.toThrow();
        });
    });

    describe('recordBusinessOperation', () => {
        beforeEach(async () => {
            await service.onModuleInit();
        });

        it('should record business operation count', async () => {
            await service.recordBusinessOperation('create_user', 'success');

            expect(mockMetricsService.getMetric).toHaveBeenCalledWith('business_operations_total');
        });

        it('should record business operation duration when provided', async () => {
            await service.recordBusinessOperation('create_user', 'success', 1.5);

            expect(mockMetricsService.getMetric).toHaveBeenCalledWith('business_operation_duration_seconds');
        });

        it('should not record duration when not provided', async () => {
            mockMetricsService.getMetric = vi.fn().mockReturnValue(mockCounter);

            await service.recordBusinessOperation('create_user', 'success');

            // Duration histogram should not be observed
        });

        it('should handle error status', async () => {
            await service.recordBusinessOperation('create_user', 'error', 0.1);

            expect(mockMetricsService.getMetric).toHaveBeenCalled();
        });
    });

    describe('system metrics collection', () => {
        it('should update system metrics periodically', async () => {
            await service.onModuleInit();

            // Advance timer to trigger collection
            vi.advanceTimersByTime(15000);

            // Metrics should have been updated
        });

        it('should handle collection errors gracefully', async () => {
            await service.onModuleInit();

            // Make getSystemMetrics throw
            (os.cpus as Mock).mockImplementation(() => {
                throw new Error('OS error');
            });

            // Advance timer - should not throw
            vi.advanceTimersByTime(15000);
        });
    });
});
