/**
 * TASK-1050 W2h (README §9.8.2) — the evaluation-gap reconciler: a scheduled count of evaluation ids a run reported
 * (on `AgentTrajectoryStep` / `AiActivityRun`) that still have no `GuardrailEvaluation` row after the grace,
 * exported as the gauge `guardrail_evaluation_missing_total` on the gateway's `/metrics`. "Captured properly" is
 * measured, not assumed.
 */
import { Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import {
  GUARDRAIL_EVALUATION_RECONCILE_GRACE_MINUTES_KEY,
  GUARDRAIL_EVALUATION_RECONCILE_LOOKBACK_HOURS_KEY,
} from '../../settings-registry/descriptors/guardrail-judge.descriptors';
import { GuardrailEvaluationReconcilerService } from '../guardrail-evaluation-reconciler.service';

const NOW = new Date('2026-10-07T12:00:00Z');

function make(opts: { missing?: number; settings?: Record<string, unknown>; fail?: boolean } = {}) {
  const registry = new Registry();
  const evaluations = {
    countMissingReportedEvaluations: vi.fn(async () => {
      if (opts.fail) throw new Error('db down');
      return opts.missing ?? 0;
    }),
  };
  const settings = { resolvePlatform: vi.fn((key: string) => ({ key, value: opts.settings?.[key], source: 'system' })) };
  const service = new GuardrailEvaluationReconcilerService(evaluations as never, settings as never, registry);
  service.now = () => NOW;
  return { service, evaluations, registry };
}

const gaugeValue = async (registry: Registry) => {
  const metric = registry.getSingleMetric('guardrail_evaluation_missing_total');
  return (await metric?.get())?.values[0]?.value;
};

describe('GuardrailEvaluationReconcilerService', () => {
  it('counts ids older than the grace within the lookback and sets the gauge', async () => {
    const { service, evaluations, registry } = make({ missing: 4 });
    await expect(service.reconcile()).resolves.toBe(4);
    expect(evaluations.countMissingReportedEvaluations).toHaveBeenCalledWith(new Date('2026-10-07T11:50:00Z'), new Date('2026-10-06T12:00:00Z'));
    expect(await gaugeValue(registry)).toBe(4);
  });

  it('reads the grace and lookback from the platform settings', async () => {
    const { service, evaluations } = make({ settings: { [GUARDRAIL_EVALUATION_RECONCILE_GRACE_MINUTES_KEY]: 30, [GUARDRAIL_EVALUATION_RECONCILE_LOOKBACK_HOURS_KEY]: 2 } });
    await service.reconcile();
    expect(evaluations.countMissingReportedEvaluations).toHaveBeenCalledWith(new Date('2026-10-07T11:30:00Z'), new Date('2026-10-07T10:00:00Z'));
  });

  it('falls back to the descriptor defaults on an invalid setting', async () => {
    const { service, evaluations } = make({ settings: { [GUARDRAIL_EVALUATION_RECONCILE_GRACE_MINUTES_KEY]: 'x' } });
    await service.reconcile();
    expect(evaluations.countMissingReportedEvaluations).toHaveBeenCalledWith(new Date('2026-10-07T11:50:00Z'), expect.any(Date));
  });

  it('a failed count leaves the last gauge value and never throws out of the cron', async () => {
    const { service, registry } = make({ missing: 2 });
    await service.reconcile();
    const failing = make({ fail: true });
    await expect(failing.service.tick()).resolves.toBeUndefined();
    expect(await gaugeValue(registry)).toBe(2);
  });

  it('registers the gauge once even when the module is constructed twice on one registry', () => {
    const registry = new Registry();
    const deps = [{ countMissingReportedEvaluations: vi.fn() }, { resolvePlatform: vi.fn(() => ({ value: undefined })) }] as const;
    new GuardrailEvaluationReconcilerService(deps[0] as never, deps[1] as never, registry);
    expect(() => new GuardrailEvaluationReconcilerService(deps[0] as never, deps[1] as never, registry)).not.toThrow();
  });
});
