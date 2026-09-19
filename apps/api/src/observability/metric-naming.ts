/**
 * The gateway's Prometheus naming, derived the same way `SimplifiedMetricsService` derives it.
 *
 * ============================================================================
 * WHY A SECOND DERIVATION EXISTS AT ALL
 * ============================================================================
 * Every gateway series is prefixed from the process's service name —
 * `hope_api_` in the cluster (`base/api.yaml` sets `OTEL_SERVICE_NAME:
 * hope-api`), `api_gateway_` locally (`.env.dev`). That prefix is applied by
 * `SimplifiedMetricsService`, a DI provider.
 *
 * The metrics in this folder are installed from `main.ts`, BEFORE
 * `NestFactory.create()`: the Prisma pool is opened during the DI warmup
 * (secrets, settings registry), so a metric registered after DI would already
 * have missed acquires, and the response-counting middleware has to be the
 * outermost `app.use` to see a response the session or CORS layer short-circuits.
 * Neither can wait for a provider, so neither can ask the service for its prefix.
 *
 * Duplicating two lines of env logic is the cost. `metric-naming.test.ts` pays
 * it down by pinning the two derivations together BEHAVIOURALLY — it registers
 * a probe through the real `SimplifiedMetricsService` and asserts the name it
 * landed under. A drift here would otherwise be silent and expensive: the
 * HPA's prometheus-adapter rule matches `hope_api_prisma_pool_*` by exact
 * name, so one wrong character leaves the saturation trigger matching nothing
 * while every other panel keeps working.
 *
 * @see packages/applications/src/services/baseServices/observability/simplified-metrics.service.ts
 */

/** Mirrors `SimplifiedMetricsService`'s fallback. */
const DEFAULT_SERVICE_NAME = 'hope-service';

/**
 * The `service` label value stamped on every gateway sample — the service name
 * as written, hyphens and all (only the metric NAME is sanitized).
 */
export function gatewayServiceLabel(): string {
  return process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;
}

/**
 * The prefix every gateway metric name carries, e.g. `hope_api_`.
 *
 * `METRICS_PREFIX` overrides it when set to a non-empty value. The
 * empty-string case is not academic: `.env.dev` ships `METRICS_PREFIX=` blank,
 * and `||` (not `??`) is what makes that read as "unset" — exactly as the DI
 * service does it.
 */
export function gatewayMetricPrefix(): string {
  return process.env.METRICS_PREFIX || `${gatewayServiceLabel().replace(/-/g, '_')}_`;
}
