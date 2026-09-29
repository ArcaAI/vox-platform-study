/**
 * The model-publisher worker (TASK-1019 OD-1) — the ONLY consumer of the
 * `DownloadAiModel` queue: it downloads model weights from the Hub (or an
 * `s3://` prefix), stages them on local disk, multipart-uploads them to
 * `hope-models` with its OWN credential, and executes unregister jobs (prefix
 * delete / purge).
 *
 * Same image as the gateway, different entrypoint:
 *   node --import ./dist/instrumentation.js dist/model-publisher.main.js
 * It boots an application CONTEXT (no HTTP listener). Env loading, the PHI
 * telemetry guard and the crash handlers mirror `main.ts`.
 */
import { ILoggingService, loadEnv } from '@arcaai/applications';
import { LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { assertGenaiContentCaptureDisabled } from './bootstrap/genai-content-capture-audit';
import { flushOtel } from './instrumentation';
import { ModelPublisherWorkerModule } from './model-publisher/model-publisher-worker.module';

function logLevels(level: string): LogLevel[] {
  const levels = ['error', 'warn', 'info', 'debug', 'verbose'];
  const index = levels.indexOf(level);
  const selected = index >= 0 ? levels.slice(0, index + 1) : ['error', 'warn', 'info'];
  return selected.map((x) => (x === 'info' ? 'log' : x)) as LogLevel[];
}

async function bootstrap(): Promise<void> {
  // The same one env contract as the gateway (host env > .env.<NODE_ENV> >
  // default; no file at all in CI / production) — BEFORE anything reads env.
  loadEnv();
  assertGenaiContentCaptureDisabled();

  const app = await NestFactory.createApplicationContext(ModelPublisherWorkerModule, {
    logger: logLevels(process.env.LOG_LEVEL ?? 'info'),
    bufferLogs: true,
  });

  const loggingService = app.get(ILoggingService);
  app.useLogger(loggingService);

  const { registerCrashHandlers } = await import('./crash-handlers');
  registerCrashHandlers(loggingService);

  // Graceful stop: close the context (BullMQ lets the in-flight job finish or
  // releases it for another worker; the job is retry-safe), then flush OTel.
  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    loggingService.info(`Model publisher worker received ${signal}; shutting down`, undefined, 'ModelPublisher');
    try {
      await app.close();
    } finally {
      await flushOtel();
      process.exit(0);
    }
  };
  process.once('SIGTERM', (signal) => void shutdown(signal));
  process.once('SIGINT', (signal) => void shutdown(signal));

  loggingService.info('Model publisher worker started — consuming the DownloadAiModel queue', undefined, 'ModelPublisher');
}

void bootstrap().catch((error: unknown) => {
  console.error('[ModelPublisher] Failed to start:', error);
  process.exit(1);
});
