import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
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
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4317';

    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-grpc');

    await import('../instrumentation');

    expect(OTLPTraceExporter).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://collector:4317',
      }),
    );
  });

  it('should configure OTLPLogExporter with endpoint from env', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4317';

    const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-grpc');

    await import('../instrumentation');

    expect(OTLPLogExporter).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://collector:4317',
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

  it('should use default endpoint when env var not set', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-grpc');

    await import('../instrumentation');

    expect(OTLPTraceExporter).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://localhost:4317',
      }),
    );
  });
});
