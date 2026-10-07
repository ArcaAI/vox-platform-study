import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Gauge, register, type Registry } from 'prom-client';
import { GuardrailEvaluationRepository } from '@arcaai/domains';
import { GUARDRAIL_EVALUATION_MISSING_METRIC } from '../platform-metrics/guardrail-promql';
import {
  GUARDRAIL_EVALUATION_RECONCILE_GRACE_MINUTES_KEY,
  GUARDRAIL_EVALUATION_RECONCILE_LOOKBACK_HOURS_KEY,
  GUARDRAIL_JUDGE_DEFAULTS,
} from '../settings-registry/descriptors/guardrail-judge.descriptors';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';

/** DI token for a non-default prom-client registry (tests). Absent: the process-wide `register` `/metrics` serves. */
export const GUARDRAIL_RECONCILER_METRICS_REGISTRY = Symbol('GUARDRAIL_RECONCILER_METRICS_REGISTRY');

const MINUTE_MS = 60_000;

/**
 * TASK-1050 W2h (README §9.8.2) — the evaluation-gap reconciler.
 *
 * TEXT returns `guardrailEvaluationIds` on every generate response and the harness stores them on the
 * `AgentTrajectoryStep` / `AiActivityRun` it reports (`_metadata.guardrailEvaluationIds`). Guardrail's outbox
 * delivers each record at-least-once. Every five minutes this counts the reported ids older than the grace
 * (`guardrail.evaluations.reconcileGraceMinutes`) and newer than the lookback that STILL have no
 * `GuardrailEvaluation` row, and sets the gauge `guardrail_evaluation_missing_total` — the series the
 * "evaluation records missing" alert reads. Runs outside any request, so the read spans every tenant.
 *
 * Every gateway replica computes the same number from the same tables (the PromQL takes the `max`), so there is
 * no lock: a duplicated count costs one query, never a wrong answer.
 */
@Injectable()
export class GuardrailEvaluationReconcilerService {
  private readonly logger = new Logger(GuardrailEvaluationReconcilerService.name);
  private readonly gauge: Gauge<string>;
  /** Clock seam for tests. */
  now: () => Date = () => new Date();

  constructor(
    private readonly evaluations: GuardrailEvaluationRepository,
    private readonly settings: TenantSettingsService,
    @Optional() @Inject(GUARDRAIL_RECONCILER_METRICS_REGISTRY) registry?: Registry,
  ) {
    const target = registry ?? register;
    const existing = target.getSingleMetric(GUARDRAIL_EVALUATION_MISSING_METRIC);
    this.gauge =
      (existing as Gauge<string> | undefined) ??
      new Gauge({
        name: GUARDRAIL_EVALUATION_MISSING_METRIC,
        help: 'Guardrail evaluation ids a run reported that have no GuardrailEvaluation row after the reconcile grace (TASK-1050).',
        registers: [target],
      });
  }

  @Cron('*/5 * * * *', { name: 'guardrail-evaluation-reconcile' })
  async tick(): Promise<void> {
    await this.reconcile().catch((error: unknown) => {
      // The gauge keeps its last value: a failed count is "unknown", never "zero missing".
      this.logger.warn({ message: 'guardrail.evaluations.reconcile_failed', error: error instanceof Error ? error.name : 'unknown' });
    });
  }

  /** One pass; returns the count it set. Throws on a failed read (the cron swallows it). */
  async reconcile(): Promise<number> {
    const now = this.now().getTime();
    const graceMinutes = this.read(GUARDRAIL_EVALUATION_RECONCILE_GRACE_MINUTES_KEY);
    const lookbackHours = this.read(GUARDRAIL_EVALUATION_RECONCILE_LOOKBACK_HOURS_KEY);
    const olderThan = new Date(now - graceMinutes * MINUTE_MS);
    const since = new Date(now - lookbackHours * 60 * MINUTE_MS);
    const missing = await this.evaluations.countMissingReportedEvaluations(olderThan, since);
    this.gauge.set(missing);
    return missing;
  }

  private read(key: typeof GUARDRAIL_EVALUATION_RECONCILE_GRACE_MINUTES_KEY | typeof GUARDRAIL_EVALUATION_RECONCILE_LOOKBACK_HOURS_KEY): number {
    try {
      const value = this.settings.resolvePlatform<number>(key).value;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
    } catch {
      // open-to-default
    }
    return GUARDRAIL_JUDGE_DEFAULTS[key];
  }
}
