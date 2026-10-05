/**
 * ONE-OFF dev cleanup: close the consultations left behind by aborted e2e runs - THROUGH THE
 * LIFECYCLE SERVICE, never a raw Prisma UPDATE.
 *
 * WHY
 * ---
 * `ConsultationTimeoutSweepService` auto-pauses a RECORDING consultation after
 * `consultation.state.recordingStaleMinutes` without activity and auto-closes every non-closed one
 * past the tenant's `consultation.autoClose` policy (12 hours idle by default). Both windows are
 * far longer than the age of freshly aborted e2e rows, so the standing sweep would not touch them
 * for hours. This script calls the SAME service with a SHORTER window passed as an explicit
 * per-call override, so nothing about the standing settings changes.
 *
 * WHAT IT DOES (two passes, both through `ConsultationTimeoutSweepService`)
 * ------------------------------------------------------------------------
 *   1. `sweepStaleRecordings({ recordingStaleMinutes })` - a RECORDING row idle past the window is
 *      auto-paused. A row that still holds a live-summary lock is shown as a live capture in the
 *      dry run, but the pause itself is decided by the window alone.
 *   2. `sweepAutoClose({ idleMinutes })` - every non-closed row idle past the window is closed
 *      (approved -> complete, anything else -> incomplete).
 *
 * Both legs refuse a window below one minute, so the windows below are 1 and 30 minutes, not 0.
 *
 * SAFETY
 * ------
 *   - DRY RUN IS THE DEFAULT. Prints every row it WOULD act on; writes nothing unless `--apply`.
 *   - Refuses to run when `NODE_ENV=production`.
 *   - Never invoked automatically; the orchestrator runs it by hand.
 *
 * USAGE (build first - a Nest app script must run against `nest build` output, not `tsx`, because
 * NestJS DI relies on `emitDecoratorMetadata`, which esbuild-based runners do not emit)
 * -----
 *   pnpm --filter @arcaai/api build
 *
 *   # 1. dry run (default) - prints the plan, writes nothing
 *   pnpm api:cleanup-orphan-consultations
 *
 *   # 2. apply, after reviewing the dry-run output
 *   pnpm api:cleanup-orphan-consultations -- --apply
 */
import { NestFactory } from '@nestjs/core';
import { ConsultationRepository } from '@arcaai/domains';
import { ConsultationTimeoutSweepService, IRedisCacheService, liveSummaryLockKey } from '@arcaai/applications';
import { AppModule } from '../app.module';

/** Idle minutes before a RECORDING row is auto-paused. */
const RECORDING_OVERRIDE_MINUTES = 1;
/** Idle minutes before any other non-closed row is closed. */
const CLOSE_OVERRIDE_MINUTES = 30;

interface Options {
  apply: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--help' || arg === '-h') {
      // eslint-disable-next-line no-console -- CLI script, not application logging
      console.log('usage: cleanup-orphan-consultations.ts [--apply]');
      process.exit(0);
    } else {
      // eslint-disable-next-line no-console -- CLI script, not application logging
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

async function previewStaleRecording(consultationRepository: ConsultationRepository, cacheService: IRedisCacheService, cutoff: Date): Promise<void> {
  const rows = await consultationRepository.findStaleRecording(cutoff);
  // eslint-disable-next-line no-console -- CLI script, not application logging
  console.log(`\nRECORDING rows idle for more than ${RECORDING_OVERRIDE_MINUTES}m (cutoff ${cutoff.toISOString()}): ${rows.length}`);
  for (const row of rows) {
    const held = await cacheService.get(liveSummaryLockKey(row.id));
    const verdict = held ? 'holds a live-summary lock — WOULD still be auto-paused (idle past the window)' : 'no lock — WOULD be auto-paused';
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log(`  ${row.id}  tenant=${row.tenantId}  lastActivityAt=${row.lastActivityAt.toISOString()}  ${verdict}`);
  }
}

async function previewAutoClose(consultationRepository: ConsultationRepository, cutoff: Date): Promise<void> {
  const rows = await consultationRepository.findAutoCloseEligible(cutoff);
  // eslint-disable-next-line no-console -- CLI script, not application logging
  console.log(`\nNon-closed rows idle for more than ${CLOSE_OVERRIDE_MINUTES}m (cutoff ${cutoff.toISOString()}, first ${rows.length}):`);
  for (const row of rows) {
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log(`  ${row.id}  tenant=${row.tenantId}  status=${row.status}  lastActivityAt=${row.lastActivityAt.toISOString()}  WOULD be closed`);
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.error('[cleanup-orphan-consultations] refusing to run with NODE_ENV=production — this is a dev-data cleanup, not an ops tool.');
    process.exit(2);
  }

  const opts = parseArgs(process.argv.slice(2));
  const mode = opts.apply ? 'APPLY' : 'DRY RUN (default — no writes)';
  // eslint-disable-next-line no-console -- CLI script, not application logging
  console.log(`[cleanup-orphan-consultations] mode: ${mode}`);

  const app = await NestFactory.create(AppModule, { logger: ['warn', 'error'] });

  try {
    const consultationRepository = app.get(ConsultationRepository);
    const cacheService = app.get<IRedisCacheService>(IRedisCacheService);
    const sweepService = app.get(ConsultationTimeoutSweepService);

    const recordingCutoff = new Date(Date.now() - RECORDING_OVERRIDE_MINUTES * 60_000);
    const drainingCutoff = new Date(Date.now() - CLOSE_OVERRIDE_MINUTES * 60_000);

    if (!opts.apply) {
      await previewStaleRecording(consultationRepository, cacheService, recordingCutoff);
      await previewAutoClose(consultationRepository, drainingCutoff);
      // eslint-disable-next-line no-console -- CLI script, not application logging
      console.log('\nDRY RUN — no rows were modified. Re-run with --apply to transition these rows.');
      return;
    }

    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log('\nRunning the RECORDING leg (auto-pausing stale RECORDING rows)...');
    const recordingResult = await sweepService.sweepStaleRecordings({ recordingStaleMinutes: RECORDING_OVERRIDE_MINUTES });
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log(`  ${JSON.stringify(recordingResult)}`);

    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log('\nRunning the auto-close sweep...');
    const sweepResult = await sweepService.sweepAutoClose({ idleMinutes: CLOSE_OVERRIDE_MINUTES });
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log(`  ${JSON.stringify(sweepResult)}`);
  } finally {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.error('[cleanup-orphan-consultations] failed:', error);
    process.exit(1);
  });
