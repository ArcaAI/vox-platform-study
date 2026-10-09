import { Counter, Gauge, register } from 'prom-client';

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
/** TASK-1055 review R2-F4 — FROZEN names: the deployment repo's alert rules are written on them. */
export const RESIDENCY_SERVICE_REACHABLE = 'residency_service_reachable';
export const RESIDENCY_LIVE_PATH_MODEL_LOADED = 'residency_live_path_model_loaded';

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

/**
 * TASK-1055 review R2-F4 — `1` when the service's residency agent answered this tick's report read, `0`
 * when it did not (or never has). `service` ∈ the commanded services (stt, nlp, lm-studio): fixed cardinality.
 */
export const residencyServiceReachable: Gauge<'service'> =
  (register.getSingleMetric(RESIDENCY_SERVICE_REACHABLE) as Gauge<'service'> | undefined) ??
  new Gauge({
    name: RESIDENCY_SERVICE_REACHABLE,
    help: 'Whether the residency controller reached the service`s residency agent on its last tick (1) or not (0). service=stt|nlp|lm-studio.',
    labelNames: ['service'] as const,
    registers: [register],
  });

/**
 * TASK-1055 review R2-F4 — per live-path model (OD-6: "live-path model not loaded" is an alert, never a
 * pod gate), `1` when its service reports it loaded and `0` when it does not. Re-built every tick, so a
 * model that leaves the live path drops out. Cardinality = the live path (a handful of catalogue models).
 */
export const residencyLivePathModelLoaded: Gauge<'service' | 'model_ref'> =
  (register.getSingleMetric(RESIDENCY_LIVE_PATH_MODEL_LOADED) as Gauge<'service' | 'model_ref'> | undefined) ??
  new Gauge({
    name: RESIDENCY_LIVE_PATH_MODEL_LOADED,
    help: 'Whether each live-path model is loaded on its service (1) or not (0), as the residency controller last observed it.',
    labelNames: ['service', 'model_ref'] as const,
    registers: [register],
  });
