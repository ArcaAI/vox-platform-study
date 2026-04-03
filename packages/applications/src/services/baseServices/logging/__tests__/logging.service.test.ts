/**
 * LoggingService Unit Tests
 *
 * Tests for the main logging service implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LoggingService } from '../logging.service';
import type { ILogTransport, LogEntry, LogLevel, TransportState } from '../transports/types';

// Mock transport for testing
class MockTransport implements ILogTransport {
    public logs: LogEntry[] = [];
    public initialized = false;
    public flushed = false;
    public wasShutdown = false;
    private _state: TransportState = 'initialized';

    constructor(
        public readonly name: string = 'mock',
        public readonly config: any = { name: 'mock', enabled: true }
    ) {}

    get state(): TransportState {
        return this._state;
    }

    async initialize(): Promise<void> {
        this.initialized = true;
        this._state = 'running';
    }

    log(entry: LogEntry): void {
        this.logs.push(entry);
    }

    async flush(): Promise<void> {
        this.flushed = true;
    }

    async shutdown(): Promise<void> {
        this.wasShutdown = true;
        this._state = 'stopped';
    }

    shouldLog(level: LogLevel): boolean {
        return true;
    }

    clear(): void {
        this.logs = [];
    }
}

describe('LoggingService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.resetModules();
        process.env = {
            ...originalEnv,
            NODE_ENV: 'test',
            LOG_CONSOLE_ENABLED: 'false', // Disable console transport for cleaner tests
            LOG_FILE_ENABLED: 'false',
            SERVICE_NAME: 'test-service',
            SERVICE_VERSION: '1.0.0',
        };
    });

    afterEach(() => {
        process.env = originalEnv;
        vi.restoreAllMocks();
    });

    describe('constructor', () => {
        it('should create service with default configuration', () => {
            const service = new LoggingService();
            expect(service).toBeDefined();
        });

        it('should use environment variables for configuration', () => {
            process.env.SERVICE_NAME = 'my-api';
            process.env.SERVICE_VERSION = '2.0.0';
            process.env.LOG_LEVEL = 'debug';

            const service = new LoggingService();
            expect(service.getLevel()).toBe('debug');
        });

        it('should parse log level from environment', () => {
            process.env.LOG_LEVEL = 'warn';
            const service = new LoggingService();
            expect(service.getLevel()).toBe('warn');
        });

        it('should handle verbose as trace level', () => {
            process.env.LOG_LEVEL = 'verbose';
            const service = new LoggingService();
            expect(service.getLevel()).toBe('trace');
        });

        it('should default to info level for invalid level', () => {
            process.env.LOG_LEVEL = 'invalid';
            const service = new LoggingService();
            expect(service.getLevel()).toBe('info');
        });
    });

    describe('lifecycle', () => {
        it('should initialize transports on module init', async () => {
            const service = new LoggingService();
            const mockTransport = new MockTransport();
            service.addTransport(mockTransport);

            await service.onModuleInit();

            expect(mockTransport.initialized).toBe(true);
        });

        it('should flush and shutdown transports on module destroy', async () => {
            const service = new LoggingService();
            const mockTransport = new MockTransport();
            service.addTransport(mockTransport);

            await service.onModuleDestroy();

            expect(mockTransport.flushed).toBe(true);
            expect(mockTransport.wasShutdown).toBe(true);
        });
    });

    describe('log methods', () => {
        let service: LoggingService;
        let mockTransport: MockTransport;

        beforeEach(() => {
            service = new LoggingService();
            mockTransport = new MockTransport();
            service.addTransport(mockTransport);
        });

        it('should log fatal messages', () => {
            service.fatal('Fatal error occurred', 'TestContext');

            expect(mockTransport.logs).toHaveLength(1);
            expect(mockTransport.logs[0].level).toBe('fatal');
            expect(mockTransport.logs[0].message).toBe('Fatal error occurred');
            expect(mockTransport.logs[0].context).toBe('TestContext');
        });

        it('should log error messages', () => {
            service.error('Error occurred', 'TestContext');

            expect(mockTransport.logs).toHaveLength(1);
            expect(mockTransport.logs[0].level).toBe('error');
        });

        it('should log error with Error object', () => {
            const error = new Error('Test error');
            service.error('Error occurred', error, 'TestContext');

            expect(mockTransport.logs).toHaveLength(1);
            expect(mockTransport.logs[0].error).toBe(error);
        });

        it('should log warn messages', () => {
            service.warn('Warning message', 'TestContext');

            expect(mockTransport.logs).toHaveLength(1);
            expect(mockTransport.logs[0].level).toBe('warn');
        });

        it('should log info messages', () => {
            service.info('Info message', 'TestContext');

            expect(mockTransport.logs).toHaveLength(1);
            expect(mockTransport.logs[0].level).toBe('info');
        });

        it('should log debug messages', () => {
            service.debug('Debug message', 'TestContext');

            expect(mockTransport.logs).toHaveLength(1);
            expect(mockTransport.logs[0].level).toBe('debug');
        });

        it('should log verbose messages as trace', () => {
            service.verbose('Verbose message', 'TestContext');

            expect(mockTransport.logs).toHaveLength(1);
            expect(mockTransport.logs[0].level).toBe('trace');
        });

        it('should log http messages', () => {
            service.http('HTTP request', { method: 'GET', path: '/api' }, 'HttpContext');

            expect(mockTransport.logs).toHaveLength(1);
            expect(mockTransport.logs[0].level).toBe('info');
            expect(mockTransport.logs[0].meta?.http).toBe(true);
        });

        it('should log with explicit level', () => {
            service.logWithLevel('warn', 'Warning message', { custom: 'meta' }, 'TestContext');

            expect(mockTransport.logs).toHaveLength(1);
            expect(mockTransport.logs[0].level).toBe('warn');
            expect(mockTransport.logs[0].meta?.custom).toBe('meta');
        });
    });

    describe('log entry structure', () => {
        let service: LoggingService;
        let mockTransport: MockTransport;

        beforeEach(() => {
            process.env.SERVICE_NAME = 'test-api';
            process.env.SERVICE_VERSION = '1.2.3';
            service = new LoggingService();
            mockTransport = new MockTransport();
            service.addTransport(mockTransport);
        });

        it('should include timestamp', () => {
            service.info('Test message');

            const entry = mockTransport.logs[0];
            expect(entry.timestamp).toBeDefined();
            expect(entry.timestampMs).toBeDefined();
            expect(typeof entry.timestampMs).toBe('number');
        });

        it('should include service info', () => {
            service.info('Test message');

            const entry = mockTransport.logs[0];
            expect(entry.serviceName).toBe('test-api');
            expect(entry.serviceVersion).toBe('1.2.3');
        });

        it('should include environment', () => {
            service.info('Test message');

            const entry = mockTransport.logs[0];
            expect(entry.environment).toBe('test');
        });

        it('should include hostname and pid', () => {
            service.info('Test message');

            const entry = mockTransport.logs[0];
            expect(entry.hostname).toBeDefined();
            expect(entry.pid).toBeDefined();
            expect(typeof entry.pid).toBe('number');
        });

        it('should include level number', () => {
            service.info('Test message');

            const entry = mockTransport.logs[0];
            expect(entry.levelNumber).toBe(30); // info = 30
        });
    });

    describe('metadata handling', () => {
        let service: LoggingService;
        let mockTransport: MockTransport;

        beforeEach(() => {
            service = new LoggingService();
            mockTransport = new MockTransport();
            service.addTransport(mockTransport);
        });

        it('should include trace context from metadata', () => {
            service.info('Test', { traceId: 'trace-123', spanId: 'span-456' });

            const entry = mockTransport.logs[0];
            expect(entry.traceId).toBe('trace-123');
            expect(entry.spanId).toBe('span-456');
        });

        it('should include request context from metadata', () => {
            service.info('Test', { requestId: 'req-123', userId: 'user-456', tenantId: 'tenant-789' });

            const entry = mockTransport.logs[0];
            expect(entry.requestId).toBe('req-123');
            expect(entry.userId).toBe('user-456');
            expect(entry.tenantId).toBe('tenant-789');
        });

        it('should include extra metadata', () => {
            service.info('Test', { custom: 'value', duration: 150 });

            const entry = mockTransport.logs[0];
            expect(entry.meta?.custom).toBe('value');
            expect(entry.meta?.duration).toBe(150);
        });

        it('should handle string as context parameter', () => {
            service.info('Test', 'MyContext');

            const entry = mockTransport.logs[0];
            expect(entry.context).toBe('MyContext');
        });

        it('should handle Error object in metadata', () => {
            const error = new Error('Test error');
            service.error('Error occurred', error);

            const entry = mockTransport.logs[0];
            expect(entry.error).toBe(error);
        });
    });

    describe('context management', () => {
        let service: LoggingService;
        let mockTransport: MockTransport;

        beforeEach(() => {
            service = new LoggingService();
            mockTransport = new MockTransport();
            service.addTransport(mockTransport);
        });

        it('should set global context', () => {
            service.setContext('GlobalContext');
            service.info('Test message');

            const entry = mockTransport.logs[0];
            expect(entry.context).toBe('GlobalContext');
        });

        it('should override global context with explicit context', () => {
            service.setContext('GlobalContext');
            service.info('Test message', 'ExplicitContext');

            const entry = mockTransport.logs[0];
            expect(entry.context).toBe('ExplicitContext');
        });
    });

    describe('child loggers', () => {
        let service: LoggingService;
        let mockTransport: MockTransport;

        beforeEach(() => {
            service = new LoggingService();
            mockTransport = new MockTransport();
            service.addTransport(mockTransport);
        });

        it('should create child logger with context', () => {
            const child = service.child('ChildContext');
            child.info('Child message');

            const entry = mockTransport.logs[0];
            expect(entry.context).toBe('ChildContext');
        });

        it('should share transports with parent', () => {
            const child = service.child('ChildContext');
            child.info('Child message');

            // Should log to same transport
            expect(mockTransport.logs).toHaveLength(1);
        });

        it('should inherit default metadata', () => {
            const parent = service.withMeta({ requestId: 'req-123' });
            const child = parent.child('ChildContext');
            child.info('Child message');

            const entry = mockTransport.logs[0];
            expect(entry.requestId).toBe('req-123');
            expect(entry.context).toBe('ChildContext');
        });
    });

    describe('withMeta', () => {
        let service: LoggingService;
        let mockTransport: MockTransport;

        beforeEach(() => {
            service = new LoggingService();
            mockTransport = new MockTransport();
            service.addTransport(mockTransport);
        });

        it('should create logger with default metadata', () => {
            const withMeta = service.withMeta({ requestId: 'req-123', userId: 'user-456' });
            withMeta.info('Test message');

            const entry = mockTransport.logs[0];
            expect(entry.requestId).toBe('req-123');
            expect(entry.userId).toBe('user-456');
        });

        it('should merge metadata with log-specific metadata', () => {
            const withMeta = service.withMeta({ requestId: 'req-123' });
            withMeta.info('Test', { custom: 'value' });

            const entry = mockTransport.logs[0];
            expect(entry.requestId).toBe('req-123');
            expect(entry.meta?.custom).toBe('value');
        });

        it('should share transports with parent', () => {
            const withMeta = service.withMeta({ requestId: 'req-123' });
            withMeta.info('Test message');

            expect(mockTransport.logs).toHaveLength(1);
        });
    });

    describe('flush', () => {
        it('should flush all transports', async () => {
            const service = new LoggingService();
            const transport1 = new MockTransport('transport1');
            const transport2 = new MockTransport('transport2');
            service.addTransport(transport1);
            service.addTransport(transport2);

            await service.flush();

            expect(transport1.flushed).toBe(true);
            expect(transport2.flushed).toBe(true);
        });
    });

    describe('level management', () => {
        it('should get current log level', () => {
            process.env.LOG_LEVEL = 'warn';
            const service = new LoggingService();

            expect(service.getLevel()).toBe('warn');
        });

        it('should set log level dynamically', () => {
            const service = new LoggingService();
            service.setLevel('debug');

            expect(service.getLevel()).toBe('debug');
        });
    });

    describe('NestJS LoggerService compatibility', () => {
        let service: LoggingService;
        let mockTransport: MockTransport;

        beforeEach(() => {
            service = new LoggingService();
            mockTransport = new MockTransport();
            service.addTransport(mockTransport);
        });

        it('should implement log method', () => {
            service.log('Log message', 'NestContext');

            expect(mockTransport.logs).toHaveLength(1);
            expect(mockTransport.logs[0].level).toBe('info');
            expect(mockTransport.logs[0].context).toBe('NestContext');
        });

        it('should handle object messages', () => {
            service.log({ key: 'value' }, 'NestContext');

            expect(mockTransport.logs).toHaveLength(1);
            expect(mockTransport.logs[0].message).toContain('key');
        });

        it('should implement setLogLevels', () => {
            service.setLogLevels?.(['verbose']);
            expect(service.getLevel()).toBe('trace');

            service.setLogLevels?.(['debug']);
            expect(service.getLevel()).toBe('debug');

            service.setLogLevels?.(['log']);
            expect(service.getLevel()).toBe('info');

            service.setLogLevels?.(['warn']);
            expect(service.getLevel()).toBe('warn');

            service.setLogLevels?.(['error']);
            expect(service.getLevel()).toBe('error');
        });
    });

    describe('transport management', () => {
        it('should add custom transport', () => {
            const service = new LoggingService();
            const customTransport = new MockTransport('custom');

            service.addTransport(customTransport);
            service.info('Test message');

            expect(customTransport.logs).toHaveLength(1);
        });

        it('should get transport names', () => {
            process.env.LOG_CONSOLE_ENABLED = 'true';
            const service = new LoggingService();
            const customTransport = new MockTransport('custom');
            service.addTransport(customTransport);

            const names = service.getTransportNames();

            expect(names).toContain('custom');
        });
    });

    describe('message formatting', () => {
        let service: LoggingService;
        let mockTransport: MockTransport;

        beforeEach(() => {
            service = new LoggingService();
            mockTransport = new MockTransport();
            service.addTransport(mockTransport);
        });

        it('should format string messages', () => {
            service.info('Simple string message');

            expect(mockTransport.logs[0].message).toBe('Simple string message');
        });

        it('should stringify object messages', () => {
            service.info({ key: 'value', nested: { data: 123 } } as any);

            const message = mockTransport.logs[0].message;
            expect(message).toContain('key');
            expect(message).toContain('value');
        });

        it('should handle non-serializable objects', () => {
            const circular: any = { a: 1 };
            circular.self = circular;

            // Should not throw
            expect(() => service.info(circular as any)).not.toThrow();
        });
    });

    describe('transport error handling', () => {
        it('should continue logging if one transport fails', () => {
            const service = new LoggingService();
            const failingTransport = new MockTransport('failing');
            failingTransport.log = () => {
                throw new Error('Transport error');
            };
            const workingTransport = new MockTransport('working');

            service.addTransport(failingTransport);
            service.addTransport(workingTransport);

            // Should not throw
            expect(() => service.info('Test message')).not.toThrow();

            // Working transport should still receive the log
            expect(workingTransport.logs).toHaveLength(1);
        });
    });

    describe('OTel Log Bridge transport selection', () => {
        const originalEnv = { ...process.env };

        afterEach(() => {
            process.env = { ...originalEnv };
        });

        it('should use OTelLogBridgeTransport when OTEL_LOGS_ENABLED=true and OTEL_LOG_BRIDGE=true', () => {
            process.env.OTEL_LOGS_ENABLED = 'true';
            process.env.OTEL_LOG_BRIDGE = 'true';
            process.env.LOG_CONSOLE_ENABLED = 'false';

            const service = new LoggingService();
            const names = service.getTransportNames();

            expect(names).toContain('otel-bridge');
        });

        it('should NOT use OTelTransport (HTTP) when OTEL_LOG_BRIDGE=true', () => {
            process.env.OTEL_LOGS_ENABLED = 'true';
            process.env.OTEL_LOG_BRIDGE = 'true';
            process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4317';
            process.env.LOG_CONSOLE_ENABLED = 'false';

            const service = new LoggingService();
            const names = service.getTransportNames();

            expect(names).toContain('otel-bridge');
            expect(names).not.toContain('otel');
        });

        it('should fall back to OTelTransport (HTTP) when OTEL_LOG_BRIDGE is not set', () => {
            process.env.OTEL_LOGS_ENABLED = 'true';
            process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4317';
            process.env.LOG_CONSOLE_ENABLED = 'false';
            delete process.env.OTEL_LOG_BRIDGE;

            const service = new LoggingService();
            const names = service.getTransportNames();

            expect(names).toContain('otel');
            expect(names).not.toContain('otel-bridge');
        });
    });

    describe('testLogging', () => {
        it('should output test messages at all levels', () => {
            const service = new LoggingService();
            const mockTransport = new MockTransport();
            service.addTransport(mockTransport);

            service.testLogging();

            // Should have logged multiple messages
            expect(mockTransport.logs.length).toBeGreaterThan(5);

            // Should include various levels
            const levels = mockTransport.logs.map(l => l.level);
            expect(levels).toContain('fatal');
            expect(levels).toContain('error');
            expect(levels).toContain('warn');
            expect(levels).toContain('info');
            expect(levels).toContain('debug');
            expect(levels).toContain('trace');
        });
    });
});
