import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Job, Queue } from 'bullmq';

import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { DrainReport, UsageOutboxDrainer } from './usage-outbox.drainer';
import {
  DRAIN_DEFAULTS,
  DRAIN_ENABLED_KEY,
  DRAIN_INTERVAL_SECONDS_KEY,
  USAGE_OUTBOX_DRAIN_JOB,
  USAGE_OUTBOX_QUEUE,
} from './usage-ledger.constants';

/**
 * The BullMQ half of the outbox drainer.
 *
 * BullMQ's role here is narrow and worth stating, because it is NOT the usual
 * one: it provides the periodic TICK and cross-replica single execution. It is
 * NOT the retry mechanism — retry state (`attempts`, `availableAt`, `lastError`)
 * lives on the outbox row, where it survives a Redis flush, a worker redeploy
 * and a queue rename. A money pipeline should not be able to lose its retry
 * state to a cache eviction.
 *
 * Consequently the job carries NO payload: each tick claims whatever is due.
 */
@Processor(USAGE_OUTBOX_QUEUE)
export class UsageOutboxProcessor extends WorkerHost {
  private readonly logger = new Logger(UsageOutboxProcessor.name);

  constructor(private readonly drainer: UsageOutboxDrainer) {
    super();
  }

  async process(job: Job): Promise<DrainReport> {
    this.logger.debug(`Draining usage outbox (job ${job.id})`);
    return this.drainer.drainBatch();
  }
}

/** Resolved drain schedule. */
export interface UsageOutboxDrainConfig {
  enabled: boolean;
  intervalSeconds: number;
}

/**
 * Registers the repeating drain tick in Redis.
 *
 * `upsertJobScheduler` is idempotent across replicas: every instance calls it
 * at boot, ONE scheduler entry exists, and each tick becomes one job that
 * whichever worker is free picks up. That is why this does not use a per-process
 * cron — N replicas would otherwise run N concurrent sweeps of the same rows.
 * (They would be safe, thanks to the idempotency key and the in-database
 * increments, but they would be pure waste and would multiply lock contention.)
 *
 * BEST-EFFORT AT BOOT. Redis being unreachable must not stop the API from
 * starting: the gateway's request paths do not depend on the drainer, and
 * `recordUsage` keeps writing outbox rows that a later tick will drain. The same
 * posture the harness takes toward Temporal.
 *
 * The scheduler is NOT removed on shutdown — it is shared state in Redis and
 * other replicas still need it. Turning drainage off is a settings change
 * (`metering.outbox.drain.enabled`), not a deploy.
 */
@Injectable()
export class UsageOutboxScheduler implements OnModuleInit {
  private readonly logger = new Logger(UsageOutboxScheduler.name);
  private activeIntervalSeconds: number | null = null;

  constructor(
    @InjectQueue(USAGE_OUTBOX_QUEUE) private readonly queue: Queue,
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.syncSchedulerFromConfig();
  }

  @OnEvent('app-settings.cache-refreshed')
  onSettingsRefreshed(): void {
    void this.syncSchedulerFromConfig();
  }

  getConfig(): UsageOutboxDrainConfig {
    return {
      enabled: this.appSettings.getValueWithDefault<boolean>(DRAIN_ENABLED_KEY, DRAIN_DEFAULTS.enabled),
      intervalSeconds: this.appSettings.getValueWithDefault<number>(DRAIN_INTERVAL_SECONDS_KEY, DRAIN_DEFAULTS.intervalSeconds),
    };
  }

  async syncSchedulerFromConfig(): Promise<void> {
    const { enabled, intervalSeconds } = this.getConfig();

    try {
      if (!enabled) {
        await this.queue.removeJobScheduler(USAGE_OUTBOX_DRAIN_JOB);
        this.activeIntervalSeconds = null;
        this.logger.log('Usage outbox drain disabled via settings — scheduler removed');
        return;
      }

      if (intervalSeconds === this.activeIntervalSeconds) return;
      if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) {
        this.logger.warn({ message: 'Ignoring non-positive usage outbox drain interval', intervalSeconds });
        return;
      }

      await this.queue.upsertJobScheduler(
        USAGE_OUTBOX_DRAIN_JOB,
        { every: intervalSeconds * 1000 },
        { name: USAGE_OUTBOX_DRAIN_JOB, opts: { removeOnComplete: true, removeOnFail: 100 } },
      );
      this.activeIntervalSeconds = intervalSeconds;
      this.logger.log({ message: 'Usage outbox drain scheduled', intervalSeconds });
    } catch (error) {
      // Never fatal: outbox rows accumulate safely and drain on a later tick.
      this.logger.warn(`Could not sync the usage outbox drain scheduler: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
