/**
 * TASK-1050 W2h (README §11.3 E) — the FIXED guardrail PromQL the platform guardrail monitoring view runs through
 * `PrometheusQueryService` (no generic Prometheus proxy). Metric names are guardrail's own
 * (`apps/guardrail/src/guardrail/core/metrics.py`) plus the gateway's reconciler gauge and the W2a2 outbox family.
 * A string here is a query, not configuration: the series it reads are code-defined.
 */

/** The gateway gauge the evaluation-gap reconciler exports (README §9.8.2). */
export const GUARDRAIL_EVALUATION_MISSING_METRIC = 'guardrail_evaluation_missing_total';

/** Rate window for every `rate()` below. */
const RATE = '5m';

const quantile = (q: number, by: string, bucket: string, selector = '') =>
  `histogram_quantile(${q}, sum by (le, ${by}) (rate(${bucket}${selector}[${RATE}])))`;

export const GUARDRAIL_PROMQL = Object.freeze({
  /** Screen-window latency per task family (s). */
  windowLatencyP50: quantile(0.5, 'task', 'guardrail_screen_window_latency_seconds_bucket'),
  windowLatencyP95: quantile(0.95, 'task', 'guardrail_screen_window_latency_seconds_bucket'),
  /** Inference latency per guardrail model (s). */
  modelLatencyP50: quantile(0.5, 'model', 'model_inference_latency_seconds_bucket', '{service="guardrail"}'),
  modelLatencyP95: quantile(0.95, 'model', 'model_inference_latency_seconds_bucket', '{service="guardrail"}'),
  /** Medical-judge verdicts per second. */
  judgeCallsPerSecond: `sum(rate(guardrail_medical_judge_calls_total[${RATE}]))`,
  /** Delegated peer calls per second (the judge lanes ride `text` / `nlp`), per peer and operation. */
  peerCallsPerSecond: `sum by (peer, operation) (rate(guardrail_peer_request_seconds_count[${RATE}]))`,
  queueDepth: 'sum by (gate) (guardrail_queue_depth)',
  admissionRejectionsPerSecond: `sum by (gate) (rate(guardrail_admission_rejections_total[${RATE}]))`,
  /** 0 closed, 1 half-open, 2 open. The worst replica wins. */
  circuitBreakers: 'max by (peer) (guardrail_circuit_breaker_state)',
  peerFailuresPerSecond: `sum by (peer, reason) (rate(guardrail_peer_failures_total[${RATE}]))`,
  windowCacheHitRatio: 'avg by (task) (guardrail_window_cache_hit_ratio)',
  /** Every gateway replica computes the same count, so the max is the answer. */
  evaluationsMissing: `max(${GUARDRAIL_EVALUATION_MISSING_METRIC})`,
  /** Every `guardrail_evaluation_outbox_*` series (W2a2); `__name__` names each one. */
  outbox: '{__name__=~"guardrail_evaluation_outbox_.*"}',
} as const);

export type GuardrailPromqlKey = keyof typeof GUARDRAIL_PROMQL;
