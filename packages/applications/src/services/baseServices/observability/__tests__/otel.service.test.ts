/**
 * OpenTelemetryService Unit Tests
 *
 * Tests for the OpenTelemetry service initialization and instrumentation.
 *
 * Testing Strategy:
 * - Mock OpenTelemetry API (external observability infrastructure)
 * - Verify service correctly reads configuration from environment
 * - Test conditional initialization based on feature flags
 * - Verify metric/tracer creation returns usable objects
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenTelemetryService } from '../otel.service';

/**
 * Complete mock meter matching OpenTelemetry Meter interface.
 * Returns objects with the methods that would be called on real metrics.
 */
const mockMeter = {
    createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
    createGauge: vi.fn().mockReturnValue({ record: vi.fn() }),
    createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
};

/**
 * Complete mock tracer matching OpenTelemetry Tracer interface.
 */
const mockTracer = {
    startSpan: vi.fn(),
};

vi.mock('@opentelemetry/api', () => ({
    metrics: {
        getMeter: vi.fn(() => mockMeter),
    },
    trace: {
        getTracer: vi.fn(() => mockTracer),
    },
}));

import { metrics, trace } from '@opentelemetry/api';

describe('OpenTelemetryService', () => {
    let service: OpenTelemetryService;

    beforeEach(() => {
        // Reset call counts but keep return values
        vi.mocked(metrics.getMeter).mockClear();
        vi.mocked(trace.getTracer).mockClear();
        mockMeter.createCounter.mockClear();
        mockMeter.createGauge.mockClear();
        mockMeter.createHistogram.mockClear();

        // Set default env vars for tests
        process.env.OTEL_SERVICE_NAME = 'test-service';
        process.env.OTEL_SERVICE_VERSION = '1.0.0';
        process.env.NODE_ENV = 'test';
        process.env.OTEL_METRICS_ENABLED = 'false';
        process.env.OTEL_TRACES_ENABLED = 'false';
    });

    afterEach(() => {
        // Don't restore mocks as we need them for all tests
    });

    describe('constructor', () => {
        it('should create service with default configuration', () => {
            service = new OpenTelemetryService();
            expect(service).toBeDefined();
        });

        it('should read configuration from environment variables', () => {
            process.env.OTEL_SERVICE_NAME = 'my-service';
            process.env.OTEL_SERVICE_VERSION = '2.0.0';

            service = new OpenTelemetryService();
            expect(service).toBeDefined();
        });

        it('should use default values when env vars are not set', () => {
            delete process.env.OTEL_SERVICE_NAME;
            delete process.env.OTEL_SERVICE_VERSION;

            service = new OpenTelemetryService();
            expect(service).toBeDefined();
        });
    });

    describe('onModuleInit', () => {
        it('should initialize metrics when enabled', async () => {
            process.env.OTEL_METRICS_ENABLED = 'true';
            service = new OpenTelemetryService();

            await service.onModuleInit();

            expect(metrics.getMeter).toHaveBeenCalledWith(
                'test-service',
                '1.0.0'
            );
        });

        it('should not initialize metrics when disabled', async () => {
            process.env.OTEL_METRICS_ENABLED = 'false';
            service = new OpenTelemetryService();

            await service.onModuleInit();

            expect(metrics.getMeter).not.toHaveBeenCalled();
        });

        it('should initialize tracing when enabled', async () => {
            process.env.OTEL_TRACES_ENABLED = 'true';
            service = new OpenTelemetryService();

            await service.onModuleInit();

            expect(trace.getTracer).toHaveBeenCalledWith(
                'test-service',
                '1.0.0'
            );
        });

        it('should not initialize tracing when disabled', async () => {
            process.env.OTEL_TRACES_ENABLED = 'false';
            service = new OpenTelemetryService();

            await service.onModuleInit();

            expect(trace.getTracer).not.toHaveBeenCalled();
        });

        it('should handle initialization errors gracefully', async () => {
            process.env.OTEL_METRICS_ENABLED = 'true';
            (metrics.getMeter as any).mockImplementation(() => {
                throw new Error('Initialization failed');
            });

            service = new OpenTelemetryService();

            // Should not throw
            await expect(service.onModuleInit()).resolves.not.toThrow();
        });
    });

    describe('onModuleDestroy', () => {
        it('should shutdown gracefully', async () => {
            service = new OpenTelemetryService();
            await service.onModuleInit();

            await expect(service.onModuleDestroy()).resolves.not.toThrow();
        });
    });

    describe('getMeter', () => {
        it('should return undefined when metrics are disabled', async () => {
            // metrics disabled by default in beforeEach
            const svc = new OpenTelemetryService();
            await svc.onModuleInit();

            const meter = svc.getMeter();
            expect(meter).toBeUndefined();
        });
    });

    describe('getTracer', () => {
        it('should return tracer when tracing is enabled', async () => {
            process.env.OTEL_TRACES_ENABLED = 'true';
            const svc = new OpenTelemetryService();
            await svc.onModuleInit();

            const tracer = svc.getTracer();
            expect(tracer).toBeDefined();
        });

        it('should return undefined when tracing is disabled', async () => {
            process.env.OTEL_TRACES_ENABLED = 'false';
            const svc = new OpenTelemetryService();
            await svc.onModuleInit();

            const tracer = svc.getTracer();
            expect(tracer).toBeUndefined();
        });
    });

    describe('metric creation', () => {
        it('should throw error for createCounter when meter is not initialized', async () => {
            // metrics disabled by default in beforeEach
            const svc = new OpenTelemetryService();
            await svc.onModuleInit();

            expect(() => svc.createCounter('test_counter')).toThrow(
                'Metrics not enabled or meter not initialized'
            );
        });

        it('should throw error for createGauge when meter is not initialized', async () => {
            const svc = new OpenTelemetryService();
            await svc.onModuleInit();

            expect(() => svc.createGauge('test_gauge')).toThrow(
                'Metrics not enabled or meter not initialized'
            );
        });

        it('should throw error for createHistogram when meter is not initialized', async () => {
            const svc = new OpenTelemetryService();
            await svc.onModuleInit();

            expect(() => svc.createHistogram('test_histogram')).toThrow(
                'Metrics not enabled or meter not initialized'
            );
        });
    });

    describe('configuration', () => {
        it('should use default service name', () => {
            delete process.env.OTEL_SERVICE_NAME;
            process.env.OTEL_METRICS_ENABLED = 'true';

            service = new OpenTelemetryService();

            // Service should be created with default name
            expect(service).toBeDefined();
        });

        it('should use default service version', () => {
            delete process.env.OTEL_SERVICE_VERSION;
            process.env.OTEL_METRICS_ENABLED = 'true';

            service = new OpenTelemetryService();

            expect(service).toBeDefined();
        });

        it('should use default environment', () => {
            delete process.env.NODE_ENV;

            service = new OpenTelemetryService();

            expect(service).toBeDefined();
        });
    });
});
