import { TenantSettingsService, WORKFLOW_RUNS_DEFAULTS, WORKFLOW_RUNS_RUN_STREAM_MAX_OPEN_HOURS_KEY } from '@arcaai/applications';
import { RUN_STREAM_KEY_PREFIX } from '@arcaai/async-contract';
import { WorkflowRunRepository } from '@arcaai/domains';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RunEventStreamHub } from '../workflows/run-event-stream-hub';

/** Keys asked for per `SCAN` page (a hint to Redis, not a hard size). */
export const RUN_STREAM_ORPHAN_SCAN_COUNT = 500;
/** Pages walked per sweep; a keyspace larger than this finishes on the next sweep. */
const MAX_PAGES = 200;

const EVENTS_KEY_SUFFIX = ':events';

/** `wf:run:<runId>:events` → `<runId>`, or `null` for any other key. */
function runIdOfEventsKey(key: string): string | null {
  if (!key.startsWith(RUN_STREAM_KEY_PREFIX) || !key.endsWith(EVENTS_KEY_SUFFIX)) return null;
  const runId = key.slice(RUN_STREAM_KEY_PREFIX.length, key.length - EVENTS_KEY_SUFFIX.length);
  return runId.length > 0 && !runId.includes(':') ? runId : null;
}

/**
 * `RunStreamOrphanSweeper` — TASK-1038 E2 (fix 14): the backstop for run event streams nothing
 * will ever close.
 *
 * A run's stream (`wf:run:<runId>:{seq,events,dedupe}`) gets its expiry from its terminal event,
 * or from the §6.1 terminal backstop when a delivery path notices the run ended. A run that died
 * with nobody watching it, a stream a late producer recreated after it expired (protocol-v2.md
 * §11), or a run left RUNNING for good keeps its keys forever — memory, since Redis runs without
 * persistence on this platform.
 *
 * Every ten minutes this SCANs `wf:run:*:events` and, for each stream that has NO expiry, reads
 * the run's row (outside a request the tenant-scope extension sees no CLS tenant, so the read
 * spans tenants — the retention purges' posture). The stream is CLOSED — the retention expiry on
 * all three keys, `EXPIRE … NX` (`RunEventStreamHub.expireAfterTerminal`), so a clock already set
 * is never moved — when the run is gone, terminal, or RUNNING longer than
 * `workflowRuns.runStreamMaxOpenHours`. A young RUNNING run is left alone, and a failed row read
 * leaves its stream alone: the sweep never closes on a guess.
 *
 * Idempotent and safe on every instance at once (`NX`), so it takes no lock.
 */
@Injectable()
export class RunStreamOrphanSweeper {
  private readonly logger = new Logger(RunStreamOrphanSweeper.name);
  now: () => Date = () => new Date();

  constructor(
    @Optional() private readonly hub?: RunEventStreamHub,
    @Optional() private readonly runs?: WorkflowRunRepository,
    @Optional() private readonly settings?: TenantSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'run-stream-orphan-sweep' })
  async sweep(): Promise<void> {
    await this.sweepOrphans().catch((error: unknown) =>
      this.logger.error({ message: 'Run stream orphan sweep failed', error: error instanceof Error ? error.name : 'unknown' }),
    );
  }

  async sweepOrphans(): Promise<{ scanned: number; closed: number }> {
    const hub = this.hub;
    if (!hub?.available() || !this.runs) return { scanned: 0, closed: 0 };
    const staleBefore = this.now().getTime() - this.maxOpenHours() * 3_600_000;
    let cursor = '0';
    let scanned = 0;
    let closed = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await hub.scanRunEventKeys(cursor, RUN_STREAM_ORPHAN_SCAN_COUNT);
      for (const key of result.keys) {
        const runId = runIdOfEventsKey(key);
        if (runId === null) continue;
        scanned += 1;
        if (await hub.hasExpiry(key)) continue;
        if (await this.isOrphan(runId, staleBefore)) {
          await hub.expireAfterTerminal(runId);
          closed += 1;
        }
      }
      cursor = result.cursor;
      if (cursor === '0') break;
    }
    if (closed > 0) this.logger.warn({ message: 'Run event streams with no expiry were closed', scanned, closed });
    return { scanned, closed };
  }

  /** Gone, terminal, or RUNNING past the ceiling. `false` when the row cannot be read. */
  private async isOrphan(runId: string, staleBefore: number): Promise<boolean> {
    let rows: Array<{ status: unknown; startedAt: Date }>;
    try {
      rows = (await this.runs!.findAll({ where: { runId } as never, limit: 1 })) as unknown as Array<{ status: unknown; startedAt: Date }>;
    } catch (error) {
      this.logger.debug({
        message: 'Run stream orphan sweep could not read the run',
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    const row = rows[0];
    if (!row) return true;
    if (String(row.status) !== 'RUNNING') return true;
    return row.startedAt.getTime() < staleBefore;
  }

  /** `workflowRuns.runStreamMaxOpenHours` (platform), failing open to its default. */
  private maxOpenHours(): number {
    try {
      const value = this.settings?.resolvePlatform<number>(WORKFLOW_RUNS_RUN_STREAM_MAX_OPEN_HOURS_KEY).value;
      return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : WORKFLOW_RUNS_DEFAULTS.runStreamMaxOpenHours;
    } catch {
      return WORKFLOW_RUNS_DEFAULTS.runStreamMaxOpenHours;
    }
  }
}
