/**
 * ONE-OFF dev cleanup: close the currently orphaned RECORDING/DRAINING
 * consultations left behind by aborted e2e runs — THROUGH THE LEGAL
 * LIFECYCLE TRANSITIONS, never a raw Prisma UPDATE (TASK-932 O-2, owner
 * decision OD-9, `docs/implementation/TASK-932-Platform-Admin-Console-
 * Alignment/README.md` §8.4).
 *
 * WHY
 * ---
 * `ConsultationTimeoutSweepService` normally sweeps `DRAINING` (and three
 * other states) past a 24h idle window (`consultation.state.
 * sessionTimeoutMinutes`, unchanged by this script) and, since OD-9,
 * `RECORDING` rows past a 30-minute idle window with no live-summary lock
 * (`consultation.state.recordingStaleMinutes`). Both windows are far longer
 * than the age of today's orphans (30 DRAINING + 13 RECORDING rows, 1-4.5h
 * old, from aborted e2e runs against tenant `50000000-0000-0000-0000-
 * 000000000001` plus one Global row) — the standing sweep would not touch
 * them for hours. This script calls the SAME service, with a SHORTER window
 * passed as an explicit per-call OVERRIDE, so nothing about the platform's
 * standing defaults is changed.
 *
 * WHAT IT DOES (two passes, both through `ConsultationTimeoutSweepService`)
 * ------------------------------------------------------------------------
 *   1. `sweepStaleRecordings({ recordingStaleMinutes: RECORDING_OVERRIDE_MINUTES })`
 *      — a `RECORDING` row with no `consultation:live-summary:{id}:lock` key
 *      is stopped via `ConsultationService.stopRecording` (the SAME path a
 *      real client uses), landing it in `DRAINING`. A row that still holds
 *      the lock (a genuinely live capture session) is left alone.
 *   2. `sweepOnce({ timeoutMinutes: DRAINING_OVERRIDE_MINUTES })` — the
 *      standard five-state sweep (which now also catches DRAINING rows,
 *      including any pass 1 just produced, if they are already that old —
 *      today's orphans are 1h+, so `DRAINING_OVERRIDE_MINUTES` closes them
 *      all), transitioning each to `CLOSED_INCOMPLETE`.
 *
 * DEVIATIONS FROM THE BRIEF, recorded here for the record (also reported to
 * the orchestrator):
 *   - The brief said "recordingStaleMinutes override 0" and "idleMinutes
 *     override 0 for rows whose updatedAt is older than 30 minutes". Both
 *     `sweepStaleRecordings` and `sweepOnce` share ONE non-positive-window
 *     safety guard (`< 1` refuses and returns a zero result — pre-existing
 *     for `sweepOnce`, extended unchanged to `sweepStaleRecordings`): "a
 *     non-positive window would sweep every eligible row in the platform in
 *     one tick." Passing literal `0` therefore does NOT sweep anything — it
 *     trips the guard. `RECORDING_OVERRIDE_MINUTES` below is `1` (the
 *     smallest value the guard allows) and `DRAINING_OVERRIDE_MINUTES` is
 *     `30` (the number the brief's own second clause names as the actual
 *     target population, and the same N OD-9 already approved for the
 *     standing RECORDING-leg default) — both still close every one of
 *     today's orphans, since all are at least an hour old, without
 *     reintroducing the sweep-everything footgun the guard exists to
 *     prevent.
 *
 * SAFETY
 * ------
 *   - DRY RUN IS THE DEFAULT. Prints every row it WOULD transition (and, for
 *     RECORDING rows, whether an active lock protects it); writes nothing
 *     unless `--apply` is passed.
 *   - Every write goes through `ConsultationService.stopRecording` /
 *     `ConsultationTimeoutSweepService`'s own `applyTransition` path — the
 *     legal state machine, never a raw Prisma UPDATE. `--apply` still only
 *     touches rows whose `updatedAt` is at least `DRAINING_OVERRIDE_MINUTES`
 *     (RECORDING: `RECORDING_OVERRIDE_MINUTES`) old, and a RECORDING row
 *     still holding a live-summary lock is never stopped.
 *   - Refuses to run when `NODE_ENV=production` — this is a dev-data
 *     cleanup, not an operational tool for a real environment.
 *   - Never invoked automatically; the orchestrator runs it by hand, once,
 *     after OD-9 (never a lane — see `04-application-services.md` /
 *     `14-multi-agent-worktrees.md` §3 "orchestrator owns shared surfaces").
 *
 * USAGE (build first — see the class doc on `emit-route-manifest.ts` for
 * why a Nest app script must run against `nest build` output, not `tsx`:
 * NestJS DI relies on `emitDecoratorMetadata`, which esbuild-based
 * runners do not emit)
 * -----
 *   pnpm --filter @arcaai/api build
 *
 *   # 1. dry run (default) — prints the plan, writes nothing
 *   pnpm api:cleanup-orphan-consultations
 *
 *   # 2. apply, after reviewing the dry-run output
 *   pnpm api:cleanup-orphan-consultations -- --apply
 */
import { NestFactory } from '@nestjs/core';
import { ConsultationRepository } from '@arcaai/domains';
import { ConsultationTimeoutSweepService, IRedisCacheService, liveSummaryLockKey } from '@arcaai/applications';
import { AppModule } from '../app.module';

/** OD-9's own N — see the DEVIATIONS note above for why this is 1, not 0. */
const RECORDING_OVERRIDE_MINUTES = 1;
/** The brief's own "older than 30 minutes" clause — see the DEVIATIONS note above for why this is 30, not 0. */
const DRAINING_OVERRIDE_MINUTES = 30;

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
  console.log(`\nRECORDING rows older than ${RECORDING_OVERRIDE_MINUTES}m (cutoff ${cutoff.toISOString()}): ${rows.length}`);
  for (const row of rows) {
    const held = await cacheService.get(liveSummaryLockKey(row.id));
    const verdict = held ? 'HELD BY AN ACTIVE LOCK — would be left alone' : 'no lock — WOULD be stopped (RECORDING → DRAINING)';
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log(`  ${row.id}  tenant=${row.tenantId}  updatedAt=${row.updatedAt.toISOString()}  ${verdict}`);
  }
}

async function previewSweepEligible(consultationRepository: ConsultationRepository, cutoff: Date): Promise<void> {
  const rows = await consultationRepository.findTimeoutSweepEligible(cutoff);
  // eslint-disable-next-line no-console -- CLI script, not application logging
  console.log(`\nSweep-eligible rows older than ${DRAINING_OVERRIDE_MINUTES}m (cutoff ${cutoff.toISOString()}): ${rows.length}`);
  for (const row of rows) {
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log(`  ${row.id}  tenant=${row.tenantId}  status=${row.status}  updatedAt=${row.updatedAt.toISOString()}  WOULD → CLOSED_INCOMPLETE`);
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
    const drainingCutoff = new Date(Date.now() - DRAINING_OVERRIDE_MINUTES * 60_000);

    if (!opts.apply) {
      await previewStaleRecording(consultationRepository, cacheService, recordingCutoff);
      await previewSweepEligible(consultationRepository, drainingCutoff);
      // eslint-disable-next-line no-console -- CLI script, not application logging
      console.log('\nDRY RUN — no rows were modified. Re-run with --apply to transition these rows.');
      return;
    }

    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log('\nRunning the RECORDING leg (stopping stale, lock-free RECORDING rows)...');
    const recordingResult = await sweepService.sweepStaleRecordings({ recordingStaleMinutes: RECORDING_OVERRIDE_MINUTES });
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log(`  ${JSON.stringify(recordingResult)}`);

    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log('\nRunning the standard sweep (closing eligible rows to CLOSED_INCOMPLETE)...');
    const sweepResult = await sweepService.sweepOnce({ timeoutMinutes: DRAINING_OVERRIDE_MINUTES });
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
