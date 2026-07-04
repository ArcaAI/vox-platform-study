import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

if (process.env.OTEL_DEBUG === 'true') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

// TASK-411: telemetry export is explicit opt-in — no localhost fallback.
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const sdkDisabled = process.env.OTEL_SDK_DISABLED === 'true';

if (!endpoint || sdkDisabled) {
  const reason = sdkDisabled ? 'OTEL_SDK_DISABLED=true' : 'OTEL_EXPORTER_OTLP_ENDPOINT not set';
  console.log(`[OTel] Telemetry export disabled (${reason})`);
} else {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'api-gateway',
      [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || '1.0.0',
      'service.namespace': 'hope',
      'deployment.environment.name': process.env.NODE_ENV || 'production',
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    // sdk-logs 0.220: BatchLogRecordProcessor takes an options object, not a positional exporter.
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: endpoint }) })],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
      new PrismaInstrumentation(),
    ],
  });

  sdk.start();

  let isShuttingDown = false;

  async function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[OTel] Received ${signal}, flushing telemetry...`);
    const timeout = setTimeout(() => {
      console.error('[OTel] Shutdown timed out, forcing exit');
      process.exit(1);
    }, 25_000);
    try {
      await sdk.shutdown();
      console.log('[OTel] Shutdown complete');
    } catch (err) {
      console.error('[OTel] Shutdown error:', err);
    } finally {
      clearTimeout(timeout);
    }
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
