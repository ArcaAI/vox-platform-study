import { Counter, register } from 'prom-client';

/**
 * TASK-1005 §5.1 — the controller's two Prometheus series, on prom-client's
 * process-global default `register` (the one `@willsoto/nestjs-prometheus`
 * serves at `GET /metrics`). Registration is idempotent
 * (`getSingleMetric(...) ?? new Counter(...)`), the `stt-gateway.metrics.ts`
 * precedent: a second `new Counter({name})` on the same register THROWS, and a
 * metric module must never be able to fail a boot.
 *
 * Label cardinality is fixed by construction: `action` (4 values), `mode` (2),
 * `reason` (a closed set below). No model, tenant or service label.
 */

export const RESIDENCY_DECISIONS_TOTAL = 'residency_decisions_total';
export const RESIDENCY_ADMISSION_REJECTIONS_TOTAL = 'residency_admission_rejections_total';

/**
 * Why an admission was refused:
 *  - `insufficient_memory` — the policy engine found no evictable set that makes a desired model fit;
 *  - `over_budget`         — an operator load exceeded the budget without `force` + `reason` (409 `OVER_BUDGET`);
 *  - `gpu_busy`            — another load held the card past `residency.admission.maxWaitMs` (or, for an operator, at all).
 */
export type ResidencyRejectionReason = 'insufficient_memory' | 'over_budget' | 'gpu_busy' | 'no_size';

export const residencyDecisionsTotal: Counter<'action' | 'mode'> =
  (register.getSingleMetric(RESIDENCY_DECISIONS_TOTAL) as Counter<'action' | 'mode'> | undefined) ??
  new Counter({
    name: RESIDENCY_DECISIONS_TOTAL,
    help: 'Model-residency decisions the controller took (enforce) or would have taken (shadow). action=load|unload|pin|unpin, mode=shadow|enforce.',
    labelNames: ['action', 'mode'] as const,
    registers: [register],
  });

export const residencyAdmissionRejectionsTotal: Counter<'reason'> =
  (register.getSingleMetric(RESIDENCY_ADMISSION_REJECTIONS_TOTAL) as Counter<'reason'> | undefined) ??
  new Counter({
    name: RESIDENCY_ADMISSION_REJECTIONS_TOTAL,
    help: 'Model loads the residency controller refused to admit. reason=insufficient_memory|over_budget|gpu_busy.',
    labelNames: ['reason'] as const,
    registers: [register],
  });
