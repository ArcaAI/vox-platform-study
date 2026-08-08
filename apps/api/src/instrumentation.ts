import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { resolveTelemetryPlan } from './instrumentation.flags';

if (process.env.OTEL_DEBUG === 'true') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

// Telemetry export is explicit opt-in — no localhost fallback. Resolution
// rules (incl. `OTEL_TRACES_ENABLED`, TASK-636 OBS-16) live in
// `instrumentation.flags.ts` so they are unit-testable; this module cannot be
// imported in a test without starting an SDK.
const plan = resolveTelemetryPlan(process.env);
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

let sdk: NodeSDK | undefined;

if (!plan.sdkEnabled) {
  console.log(`[OTel] Telemetry export disabled (${plan.reason})`);
} else {
  if (!plan.tracesEnabled) {
    console.log(`[OTel] ${plan.reason}`);
  }

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'api-gateway',
      [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || '1.0.0',
      'service.namespace': 'hope',
      'deployment.environment.name': process.env.NODE_ENV || 'production',
    }),
    // TASK-636 OBS-16 — `OTEL_TRACES_ENABLED=false` means "emit no spans",
    // NOT "stop understanding traces".
    //
    // An explicit EMPTY `spanProcessors` list is what expresses that. NodeSDK
    // treats it as "processors were configured" and so skips both the
    // configured exporter and its `OTEL_TRACES_EXPORTER` env fallback; with no
    // processors it registers no TracerProvider, so this process creates only
    // non-recording spans and opens no gRPC channel to the collector.
    //
    // Crucially, `setupContextManager` and `setupPropagator` run BEFORE that
    // branch in `NodeSDK.start()`, so the W3C propagator and the async-hooks
    // context manager are registered either way: a gateway with traces off
    // still EXTRACTS an inbound `traceparent` and still FORWARDS it downstream.
    // A service that severed its neighbours' traces to save its own export
    // volume would be a worse outcome than the volume.
    ...(plan.tracesEnabled ? { traceExporter: new OTLPTraceExporter({ url: endpoint }) } : { spanProcessors: [] }),
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
