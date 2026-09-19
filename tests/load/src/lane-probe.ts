/**
 * Establish EMPIRICALLY whether the limiter buckets a given credential per IP
 * or per tenant.
 *
 * ## Why this has to be measured rather than read
 *
 * A 429 from `@nestjs/throttler@6.5.0` carries no rate-limit metadata at all:
 * the guard throws before it sets `X-RateLimit-*`, and the advisory `RateLimit`
 * field is written by an interceptor that only runs on the success path. So the
 * failure itself cannot say which bucket refused it, and the lane has to be
 * established from the SUCCESSES that precede it.
 *
 * The distinction is the entire subject of TASK-993 OD-2 and defect D-1, so
 * guessing it would be guessing the answer the ticket exists to produce.
 *
 * ## Why it is PER TENANT and not one verdict for the run
 *
 * Measured against the dev gateway on 2026-09-19, two tenants on the same host
 * landed on DIFFERENT lanes in the same run:
 *
 *   Global  (`plan = null`)      → limit 100, a bucket per route  → per-IP (rank 5)
 *   ArcaAI  (`plan = ENTERPRISE`)→ limit 300, one bucket          → per-tenant (rank 3)
 *
 * That is `TieredThrottlerGuard` working exactly as written — a tenant with no
 * plan has no rank-3 opinion and falls through to the IP-keyed platform lane —
 * but it means a single run-wide verdict is guaranteed to mislabel one of them.
 * So test A runs once per tenant, and the attribution uses that tenant's own
 * answer.
 *
 * ## The two tests
 *
 * `TieredThrottlerGuard` keys ranks 1-3 as `t:<tenantId>` — no route component,
 * no principal component — and leaves ranks 4-5 on the library's own key,
 * `sha256(ClassName-handlerName-tierName-<ip>)`.
 *
 *   A. TWO ROUTES, ONE TENANT (per tenant). Per-IP ⇒ separate counters, so the
 *      second route reports a FRESH `remaining`. Per-tenant ⇒ one counter, so it
 *      continues the first's sequence. This alone is decisive, because only the
 *      tenant lane collapses routes into one bucket.
 *   B. ONE ROUTE, TWO TENANTS (once). Corroboration: per-IP ⇒ tenant B continues
 *      tenant A's sequence; per-tenant ⇒ tenant B starts fresh.
 *
 * ## What makes a verdict refusable
 *
 * Every observation is kept as evidence and printed. A test that cannot run, or
 * whose counters do not move, returns `indeterminate` rather than a guess, and
 * an `indeterminate` lane propagates into `throttle_unknown` attribution — an
 * unclassified 429 beats a confidently wrong one.
 *
 * The probe spends live counter budget, so it runs ONCE, before the load.
 */
import { issue, type Credential } from './http';
import type { LaneVerdict } from './types';

export interface LaneProbeOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly pgConnectTimeoutMs: number;
  readonly t0Ms: number;
  /** Two cheap, authenticated GET routes on DIFFERENT controllers/handlers. */
  readonly routeA: string;
  readonly routeB: string;
}

interface Observation {
  readonly label: string;
  readonly status: number | null;
  readonly limit?: number;
  readonly remaining?: number;
}

async function observe(options: LaneProbeOptions, credential: Credential, path: string, label: string): Promise<Observation> {
  const result = await issue({
    baseUrl: options.baseUrl,
    credential,
    method: 'GET',
    path,
    timeoutMs: options.timeoutMs,
    pgConnectTimeoutMs: options.pgConnectTimeoutMs,
    t0Ms: options.t0Ms,
  });
  return { label, status: result.sample.status, limit: result.sample.rateLimit?.limit, remaining: result.sample.rateLimit?.remaining };
}

function describe(observation: Observation): string {
  return `${observation.label}: HTTP ${observation.status ?? 'transport'} limit=${observation.limit ?? '?'} remaining=${observation.remaining ?? '?'}`;
}

/**
 * Warm a credential before probing with it.
 *
 * The API-key lane in `TieredThrottlerGuard` reads a Redis hint published by
 * `ApiKeyService` on the PREVIOUS successful authentication — so the first
 * request in each TTL window cannot resolve a tenant and rides the platform
 * lane regardless of the tenant's plan. Probing on that first request measures
 * the warm-up, not the lane. (Observed: an ENTERPRISE tenant's API key
 * advertising the 100/window platform baseline on request 1 and 300/window
 * from request 2.)
 */
async function warm(options: LaneProbeOptions, credential: Credential): Promise<void> {
  await observe(options, credential, options.routeA, 'warm');
}

/** Test A for ONE tenant. Decisive on its own; `crossTenantEvidence` is folded in by the caller. */
export async function probeTenantLane(options: LaneProbeOptions, credential: Credential): Promise<LaneVerdict> {
  await warm(options, credential);

  const a1 = await observe(options, credential, options.routeA, `${credential.tenantId}/routeA #1`);
  const a2 = await observe(options, credential, options.routeA, `${credential.tenantId}/routeA #2`);
  const b1 = await observe(options, credential, options.routeB, `${credential.tenantId}/routeB #1`);
  const evidence = [describe(a1), describe(a2), describe(b1)];

  if (![a1, a2, b1].every((o) => typeof o.remaining === 'number' && typeof o.limit === 'number')) {
    evidence.push('a probe response carried no X-RateLimit-* headers (a 429, a non-2xx, or throttling disabled)');
    return { lane: 'indeterminate', evidence };
  }
  if (a2.remaining! >= a1.remaining!) {
    evidence.push(
      `the counter did not decrement across two identical requests (${a1.remaining} → ${a2.remaining}); the limiter may be disabled for this tenant`,
    );
    return { lane: 'indeterminate', evidence };
  }

  const routesShareBucket = b1.remaining! < a2.remaining!;
  evidence.push(
    routesShareBucket
      ? `routeB continued routeA's sequence (${a2.remaining} → ${b1.remaining}) ⇒ ONE bucket across routes ⇒ tenant-keyed (rank 1-3)`
      : `routeB started fresh (routeA at ${a2.remaining}, routeB at ${b1.remaining}) ⇒ a bucket PER ROUTE ⇒ IP-keyed (rank 4-5)`,
  );
  return { lane: routesShareBucket ? 'per_tenant' : 'per_ip', evidence, observedLimit: a1.limit };
}

/** Test B, run once: does a second tenant continue the first's counter on the SAME route? */
export async function probeCrossTenant(options: LaneProbeOptions, credentialA: Credential, credentialB: Credential): Promise<string[]> {
  if (credentialA.tenantId === credentialB.tenantId) return ['cross-tenant check skipped: both probe credentials belong to the same tenant'];

  await warm(options, credentialA);
  await warm(options, credentialB);
  const a = await observe(options, credentialA, options.routeA, `cross/tenantA(${credentialA.tenantId.slice(0, 8)})`);
  const b = await observe(options, credentialB, options.routeA, `cross/tenantB(${credentialB.tenantId.slice(0, 8)})`);
  const evidence = [describe(a), describe(b)];

  if (typeof a.remaining !== 'number' || typeof b.remaining !== 'number') {
    evidence.push('cross-tenant check inconclusive: a response carried no counter');
    return evidence;
  }
  evidence.push(
    b.remaining < a.remaining && a.limit === b.limit
      ? `tenant B continued tenant A's sequence (${a.remaining} → ${b.remaining}) ⇒ the two SHARE a bucket on this route`
      : `tenant B has its own counter (A at ${a.remaining}/${a.limit}, B at ${b.remaining}/${b.limit}) ⇒ separate buckets`,
  );
  return evidence;
}

export interface LaneReport {
  /** tenantId → its own verdict. Attribution reads this, never a run-wide value. */
  readonly byTenant: Readonly<Record<string, LaneVerdict>>;
  readonly crossTenantEvidence: readonly string[];
}

/**
 * Probe every tenant represented in `credentials`, using one credential each,
 * and run the cross-tenant corroboration once.
 *
 * Prefers a HUMAN credential per tenant: the JWT lane verifies a signature with
 * no warm-up, while the API-key lane needs the Redis hint above and the
 * service-account lane binds its tenant at exchange.
 */
export async function probeLanes(options: LaneProbeOptions, credentials: readonly Credential[]): Promise<LaneReport> {
  const representative = new Map<string, Credential>();
  for (const credential of credentials) {
    const current = representative.get(credential.tenantId);
    if (!current || (current.kind !== 'human' && credential.kind === 'human')) representative.set(credential.tenantId, credential);
  }

  const byTenant: Record<string, LaneVerdict> = {};
  for (const [tenantId, credential] of representative) {
    byTenant[tenantId] = await probeTenantLane(options, credential);
  }

  const [first, second] = [...representative.values()];
  const crossTenantEvidence =
    first && second ? await probeCrossTenant(options, first, second) : ['cross-tenant check skipped: only one tenant had credentials'];

  return { byTenant, crossTenantEvidence };
}
