/**
 * The tenant-checkpoint worker — the ONLY consumer of the
 * `TenantCheckpointExport` and `TenantCheckpointRestore` queues: it streams a
 * tenant into a sealed archive in `hope-tenant-checkpoints`, verifies uploaded
 * archives, restores a tenant under the tenant lock, and sweeps stale jobs and
 * expired checkpoints.
 *
 * Same image as the gateway, different entrypoint:
 *   node --import ./dist/instrumentation.js dist/checkpoint-worker.main.js
 * It boots an application CONTEXT (no HTTP listener). Env loading, the PHI
 * telemetry guard and the crash handlers mirror `main.ts`.
 */
import { ICheckpointStore, ILoggingService, loadEnv } from '@arcaai/applications';
import { LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { assertGenaiContentCaptureDisabled } from './bootstrap/genai-content-capture-audit';
import { flushOtel } from './instrumentation';
import { CheckpointWorkerModule } from './checkpoint-worker/checkpoint-worker.module';

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

  const app = await NestFactory.createApplicationContext(CheckpointWorkerModule, {
    logger: logLevels(process.env.LOG_LEVEL ?? 'info'),
    bufferLogs: true,
  });

  const loggingService = app.get(ILoggingService);
  app.useLogger(loggingService);

  const { registerCrashHandlers } = await import('./crash-handlers');
  registerCrashHandlers(loggingService);

  // The checkpoint bucket is created here, idempotently, rather than by an
  // out-of-band bootstrap: re-running the MinIO bootstrap would rotate a key
  // Vault then holds stale.
  await app.get<{ ensureBucket(): Promise<void> }>(ICheckpointStore, { strict: false }).ensureBucket();

  // Graceful stop: close the context (BullMQ lets the in-flight job finish or
  // releases it for another worker; the job is retry-safe), then flush OTel.
  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    loggingService.info(`Checkpoint worker received ${signal}; shutting down`, undefined, 'CheckpointWorker');
    try {
      await app.close();
    } finally {
      await flushOtel();
      process.exit(0);
    }
  };
  process.once('SIGTERM', (signal) => void shutdown(signal));
  process.once('SIGINT', (signal) => void shutdown(signal));

  loggingService.info(
    'Checkpoint worker started — consuming the TenantCheckpointExport and TenantCheckpointRestore queues',
    undefined,
    'CheckpointWorker',
  );
}

void bootstrap().catch((error: unknown) => {
  console.error('[CheckpointWorker] Failed to start:', error);
  process.exit(1);
});
