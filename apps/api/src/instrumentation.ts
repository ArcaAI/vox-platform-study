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

// Telemetry export is explicit opt-in — no localhost fallback.
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const sdkDisabled = process.env.OTEL_SDK_DISABLED === 'true';

let sdk: NodeSDK | undefined;

if (!endpoint || sdkDisabled) {
  const reason = sdkDisabled ? 'OTEL_SDK_DISABLED=true' : 'OTEL_EXPORTER_OTLP_ENDPOINT not set';
  console.log(`[OTel] Telemetry export disabled (${reason})`);
} else {
  sdk = new NodeSDK({
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
}

/**
 * Flush and shut down the OTel SDK.
 *
 * This file MUST NOT install its own SIGTERM/SIGINT handlers or a force-exit
 * timer (TASK-616 G0.1). It previously did both: a second, uncoordinated
 * `process.on('SIGTERM', ...)` handler here raced Nest's own shutdown
 * sequence (`GracefulShutdownService`), and its 25s `process.exit(1)` timeout
 * force-killed the pod well inside the 60s `terminationGracePeriodSeconds`
 * budget — severing every in-flight WebSocket/SSE stream mid-drain.
 *
 * Instead, `main.ts` registers this function with
 * `GracefulShutdownService.registerCleanupCallback(...)` so Nest's
 * `beforeApplicationShutdown` phase owns exactly when the flush runs, with
 * its own timeout/`Promise.allSettled` coordination against every other
 * cleanup callback. Because this module is preloaded via
 * `node --import ./dist/instrumentation.js`, importing it again from
 * `main.ts` resolves to the same cached module instance — `sdk` here is the
 * live SDK, not a fresh one.
 *
 * No-op when the SDK was never started (telemetry export disabled).
 */
export async function flushOtel(): Promise<void> {
  if (!sdk) return;
  console.log('[OTel] Flushing telemetry before shutdown...');
  try {
    await sdk.shutdown();
    console.log('[OTel] Shutdown complete');
  } catch (err) {
    console.error('[OTel] Shutdown error:', err);
  }
}
