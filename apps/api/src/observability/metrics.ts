/**
 * API-process Prometheus metrics that don't fit cleanly into a service.
 *
 * `prom-client` exposes a process-global default `register`; the
 * `@willsoto/nestjs-prometheus` module (wired in
 * `packages/applications/.../observability/observability.module.ts`) serves
 * that register at `GET /metrics`, so any counter created here is
 * automatically scraped.
 *
 * @see TASK-302 Stream D Phase E.6 — `optimistic_lock_conflict_total`
 */
import { Counter, register } from 'prom-client';

/**
 * Number of `412 Precondition Failed` responses caused by optimistic
 * concurrency conflicts.
 *
 * - **`model`** — Domain model the write targeted (e.g. `'GlobalSetting'`,
 *   `'Tenant'`, `'PromptTemplate'`). Surfaced from
 *   `OptimisticConcurrencyException.model`, **not** parsed from the message
 *   string.
 * - **`route`** — Templated route + method (e.g.
 *   `'PATCH /api/v1/tenants/:id'`). We deliberately use the **templated**
 *   path (`request.route?.path`) and fall back to a query-stripped raw URL
 *   so cardinality stays bounded.
 *
 * Alert threshold (Grafana): a sustained rate `> 0.5 %` of PATCHes is
 * almost always a noisy client (chatty UI, bug in SDK ETag capture) and
 * should page the on-call.
 *
 * Tests: see
 * `apps/api/src/interceptors/__tests__/exception.interceptor.test.ts`
 * "ExceptionInterceptor — optimistic_lock_conflict_total counter" block.
 *
 * @see RFC 7232 §4.2 — semantics of 412 Precondition Failed
 * @see research/architecture/system-config-multi-tenancy/04-optimistic-locking.md §6
 */
export const OPTIMISTIC_LOCK_CONFLICT_TOTAL = 'optimistic_lock_conflict_total';

export const optimisticLockConflictTotal: Counter<'model' | 'route'> =
  (register.getSingleMetric(OPTIMISTIC_LOCK_CONFLICT_TOTAL) as Counter<'model' | 'route'> | undefined) ??
  new Counter({
    name: OPTIMISTIC_LOCK_CONFLICT_TOTAL,
    help: 'Number of 412 Precondition Failed responses caused by optimistic ' + 'concurrency conflicts. Labeled by model and templated route.',
    labelNames: ['model', 'route'] as const,
    registers: [register],
  });

/**
 * Normalise the request's route label for the Prometheus counter.
 *
 * Prefers the templated Express route (`request.route?.path`) for bounded
 * cardinality and falls back to a query-stripped raw URL for code paths
 * that error out *before* Express finishes routing (rare, but defensive).
 *
 * @internal — exported for tests; the interceptor is the only intended caller.
 */
export function routeLabel(request: { method?: string; url?: string; route?: { path?: string } }): string {
  const method = (request.method ?? 'UNKNOWN').toUpperCase();
  const templated = request.route?.path;
  const rawUrlNoQuery = (request.url ?? '/unknown').split('?')[0];
  return `${method} ${templated ?? rawUrlNoQuery}`;
}
