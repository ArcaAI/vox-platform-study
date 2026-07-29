import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

const mockSdkStart = vi.fn();
const mockSdkShutdown = vi.fn().mockResolvedValue(undefined);

vi.mock('@opentelemetry/sdk-node', () => {
  const NodeSDK = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.start = mockSdkStart;
    this.shutdown = mockSdkShutdown;
  });
  return { NodeSDK };
});

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: vi.fn().mockReturnValue([]),
}));

vi.mock('@opentelemetry/exporter-trace-otlp-grpc', () => {
  const OTLPTraceExporter = vi.fn().mockImplementation(function () {});
  return { OTLPTraceExporter };
});

vi.mock('@opentelemetry/exporter-logs-otlp-grpc', () => {
  const OTLPLogExporter = vi.fn().mockImplementation(function () {});
  return { OTLPLogExporter };
});

vi.mock('@opentelemetry/sdk-logs', () => {
  const BatchLogRecordProcessor = vi.fn().mockImplementation(function () {});
  return { BatchLogRecordProcessor };
});

vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: vi.fn().mockReturnValue({}),
}));

vi.mock('@opentelemetry/semantic-conventions', () => ({
  ATTR_SERVICE_NAME: 'service.name',
  ATTR_SERVICE_VERSION: 'service.version',
}));

vi.mock('@prisma/instrumentation', () => {
  const PrismaInstrumentation = vi.fn().mockImplementation(function () {});
  return { PrismaInstrumentation };
});

vi.mock('@opentelemetry/api', () => {
  const DiagConsoleLogger = vi.fn().mockImplementation(function () {});
  return {
    diag: { setLogger: vi.fn() },
    DiagConsoleLogger,
    DiagLogLevel: { DEBUG: 0 },
  };
});

describe('instrumentation', () => {
  const originalEnv = { ...process.env };
  const ENDPOINT = 'http://collector:4317';

  let consoleLogSpy: MockInstance;
  let processOnSpy: MockInstance;

  /** SIGTERM/SIGINT registrations made through process.on during the current test. */
  const signalRegistrations = () =>
    (processOnSpy.mock.calls as unknown as [string | symbol, () => void][]).filter(([event]) => event === 'SIGTERM' || event === 'SIGINT');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv };
    // Deterministic baseline regardless of ambient env: export is opt-in,
    // so each enabled-path test sets the endpoint explicitly.
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_SDK_DISABLED;
    delete process.env.OTEL_DEBUG;
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    processOnSpy = vi.spyOn(process, 'on');
  });

  afterEach(() => {
    // Remove signal handlers registered by the module under test so
    // repeated imports across tests don't leak process listeners.
    for (const [event, listener] of signalRegistrations()) {
      process.removeListener(event as NodeJS.Signals, listener);
    }
    processOnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    process.env = originalEnv;
  });

  describe('when OTEL_EXPORTER_OTLP_ENDPOINT is set', () => {
    beforeEach(() => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    });

    it('should create NodeSDK with correct resource attributes', async () => {
      process.env.OTEL_SERVICE_NAME = 'test-api';
      process.env.OTEL_SERVICE_VERSION = '2.0.0';
      process.env.NODE_ENV = 'test';

      const { NodeSDK } = await import('@opentelemetry/sdk-node');
      const { resourceFromAttributes } = await import('@opentelemetry/resources');

      await import('../instrumentation');

      expect(NodeSDK).toHaveBeenCalledTimes(1);
      expect(resourceFromAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          'service.name': 'test-api',
          'service.version': '2.0.0',
          'service.namespace': 'hope',
          'deployment.environment.name': 'test',
        }),
      );
    });

    it('should call sdk.start()', async () => {
      await import('../instrumentation');

      expect(mockSdkStart).toHaveBeenCalledTimes(1);
    });

    it('should configure OTLPTraceExporter with endpoint from env', async () => {
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-grpc');

      await import('../instrumentation');

      expect(OTLPTraceExporter).toHaveBeenCalledWith(
        expect.objectContaining({
          url: ENDPOINT,
        }),
      );
    });

    it('should configure OTLPLogExporter with endpoint from env', async () => {
      const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-grpc');

      await import('../instrumentation');

      expect(OTLPLogExporter).toHaveBeenCalledWith(
        expect.objectContaining({
          url: ENDPOINT,
        }),
      );
    });

    it('should disable fs and dns instrumentations', async () => {
      const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');

      await import('../instrumentation');

      expect(getNodeAutoInstrumentations).toHaveBeenCalledWith(
        expect.objectContaining({
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
        }),
      );
    });

    it('should include PrismaInstrumentation', async () => {
      const { PrismaInstrumentation } = await import('@prisma/instrumentation');

      await import('../instrumentation');

      expect(PrismaInstrumentation).toHaveBeenCalledTimes(1);
    });

    it('should use default service name when env var not set', async () => {
      delete process.env.OTEL_SERVICE_NAME;
      delete process.env.OTEL_SERVICE_VERSION;

      const { resourceFromAttributes } = await import('@opentelemetry/resources');

      await import('../instrumentation');

      expect(resourceFromAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          'service.name': 'api-gateway',
          'service.version': '1.0.0',
        }),
      );
    });

    it('should start when OTEL_SDK_DISABLED is set to a value other than "true"', async () => {
      process.env.OTEL_SDK_DISABLED = 'false';

      const { NodeSDK } = await import('@opentelemetry/sdk-node');

      await import('../instrumentation');

      expect(NodeSDK).toHaveBeenCalledTimes(1);
      expect(mockSdkStart).toHaveBeenCalledTimes(1);
    });

    it('should register SIGTERM and SIGINT shutdown handlers when the SDK starts', async () => {
      await import('../instrumentation');

      const events = signalRegistrations().map(([event]) => event);
      expect(events).toContain('SIGTERM');
      expect(events).toContain('SIGINT');
    });
  });

  describe('when telemetry export is disabled', () => {
    it('should not construct or start the SDK when the endpoint is unset', async () => {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

      const { NodeSDK } = await import('@opentelemetry/sdk-node');
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-grpc');
      const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-grpc');

      await import('../instrumentation');

      expect(NodeSDK).not.toHaveBeenCalled();
      expect(mockSdkStart).not.toHaveBeenCalled();
      expect(OTLPTraceExporter).not.toHaveBeenCalled();
      expect(OTLPLogExporter).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/telemetry export disabled/i));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('OTEL_EXPORTER_OTLP_ENDPOINT'));
    });

    it('should not construct or start the SDK when the endpoint is an empty string', async () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = '';

      const { NodeSDK } = await import('@opentelemetry/sdk-node');
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-grpc');
      const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-grpc');

      await import('../instrumentation');

      expect(NodeSDK).not.toHaveBeenCalled();
      expect(mockSdkStart).not.toHaveBeenCalled();
      expect(OTLPTraceExporter).not.toHaveBeenCalled();
      expect(OTLPLogExporter).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/telemetry export disabled/i));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('OTEL_EXPORTER_OTLP_ENDPOINT'));
    });

    it('should honor OTEL_SDK_DISABLED=true even when the endpoint is set', async () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
      process.env.OTEL_SDK_DISABLED = 'true';

      const { NodeSDK } = await import('@opentelemetry/sdk-node');

      await import('../instrumentation');

      expect(NodeSDK).not.toHaveBeenCalled();
      expect(mockSdkStart).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/telemetry export disabled/i));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('OTEL_SDK_DISABLED'));
    });

    it('should not register SIGTERM/SIGINT handlers when disabled', async () => {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

      await import('../instrumentation');

      expect(signalRegistrations()).toHaveLength(0);
    });
  });
});
