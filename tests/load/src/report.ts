/**
 * Render a run.
 *
 * The report is opinionated about one thing: it always answers "which ceiling
 * bound first", and it refuses to imply an answer it did not measure. An
 * `indeterminate` lane prints as `indeterminate`; a suspected pool timeout
 * prints as suspected; a run in which nothing failed says the offered load was
 * never enough to find a ceiling rather than "the platform is fine".
 */
import { summarize } from './stats';
import type { Aggregate } from './aggregate';
import type { Calibration } from './calibrate';
import type { LaneReport } from './lane-probe';
import type { MetricsDelta } from './metrics-probe';
import type { SessionProfile } from './scenario';
import type { HarnessConfig } from './types';

export interface RunReport {
  readonly config: HarnessConfig;
  readonly profile: SessionProfile;
  /** One verdict PER TENANT — lanes differ per tenant, so a single value would mislabel one of them. */
  readonly lanes: LaneReport;
  readonly calibration?: Calibration;
  readonly aggregate: Aggregate;
  readonly metrics?: MetricsDelta;
  readonly sessionStrategy: string;
  readonly warnings: readonly string[];
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '  0.0%' : `${((part / whole) * 100).toFixed(1).padStart(5)}%`;
}

function bar(value: number, max: number, width = 28): string {
  if (max <= 0) return '';
  return '█'.repeat(Math.max(0, Math.round((value / max) * width)));
}

/** The one-line verdict: the ceiling that accounted for the most refusals. */
export function bindingCeiling(aggregate: Aggregate): { cause: string; count: number } | null {
  const entries = Object.entries(aggregate.byCause).filter(([cause]) => cause !== 'auth' && cause !== 'client_error');
  if (entries.length === 0) return null;
  const [cause, count] = entries.sort((a, b) => b[1] - a[1])[0]!;
  return { cause, count };
}

/**
 * A JSON-serialisable view of a run.
 *
 * The raw histograms are ~2,800-element arrays each, one per route plus one per
 * principal — a two-tenant smoke run serialised to 1 MB of mostly zeroes. The
 * summaries carry every number the text report shows, and the timeline keeps
 * the per-second shape, so nothing an operator would re-analyse is lost.
 */
export function toSerializable(report: RunReport): Record<string, unknown> {
  const { aggregate } = report;
  return {
    config: report.config,
    profile: report.profile,
    lanes: report.lanes,
    calibration: report.calibration,
    sessionStrategy: report.sessionStrategy,
    warnings: report.warnings,
    metrics: report.metrics,
    aggregate: {
      startedAtMs: aggregate.startedAtMs,
      durationSeconds: aggregate.durationSeconds,
      total: aggregate.total,
      ok: aggregate.ok,
      latency: summarize(aggregate.latency),
      scheduleDelay: summarize(aggregate.scheduleDelay),
      latencyByPrincipal: Object.fromEntries(Object.entries(aggregate.latencyByPrincipal).map(([kind, h]) => [kind, summarize(h)])),
      byCause: aggregate.byCause,
      byCauseDetail: aggregate.byCauseDetail,
      byRoute: Object.fromEntries(
        Object.entries(aggregate.byRoute).map(([routeKey, stats]) => [
          routeKey,
          { total: stats.total, ok: stats.ok, failed: stats.failed, latency: summarize(stats.latency) },
        ]),
      ),
      byTenant: aggregate.byTenant,
      timeline: aggregate.timeline,
      firstThrottleAtMs: aggregate.firstThrottleAtMs,
      unattributedCorrelationIds: aggregate.unattributedCorrelationIds,
      observedLimits: aggregate.observedLimits,
    },
  };
}

export function render(report: RunReport): string {
  const { aggregate, config } = report;
  const elapsedSeconds = Math.max(1, aggregate.timeline.filter((b) => b.requests > 0).length);
  const throughput = aggregate.total / elapsedSeconds;
  const latency = summarize(aggregate.latency);
  const schedule = summarize(aggregate.scheduleDelay);
  const out: string[] = [];

  out.push(
    '',
    '════════════════════════════════════════════════════════════════════════',
    ' TASK-993 LOAD RUN',
    '════════════════════════════════════════════════════════════════════════',
    `  target        ${config.baseUrl}`,
    `  population    ${config.tenants} tenants x ${config.usersPerTenant} users` +
      ` + ${config.apiKeysPerTenant} api-key + ${config.serviceAccountsPerTenant} service-account per tenant`,
    `  arrival       ${config.arrival}   think median ${config.thinkMedianMs}ms (sigma ${config.thinkSigma})   ramp ${config.rampSeconds}s`,
    `  duration      ${config.durationSeconds}s over ${config.workers} worker threads`,
    `  route mix     ${report.profile.source} (${report.profile.requestsPerMinute} req/min/user, ${report.profile.requestsPerNavigation} per navigation)`,
    `  sessions      ${report.sessionStrategy}`,
    '',
  );

  if (report.warnings.length > 0) {
    out.push(' ── WARNINGS ───────────────────────────────────────────────────────────');
    for (const warning of report.warnings) out.push(`  ! ${warning}`);
    out.push('');
  }

  out.push(
    ' ── THROUGHPUT & LATENCY ───────────────────────────────────────────────',
    `  requests      ${aggregate.total}   ok ${aggregate.ok} (${pct(aggregate.ok, aggregate.total)})`,
    `  throughput    ${throughput.toFixed(1)} req/s  (${(throughput * 60).toFixed(0)} req/min)`,
    `  latency       p50 ${latency.p50Ms}ms   p95 ${latency.p95Ms}ms   p99 ${latency.p99Ms}ms   max ${latency.maxMs}ms`,
    // The coordinated-omission correction. A large p99 here means the run fell
    // behind its own plan, so the latency above understates what a user with a
    // fixed cadence would have experienced.
    `  schedule lag  p50 ${schedule.p50Ms}ms   p95 ${schedule.p95Ms}ms   p99 ${schedule.p99Ms}ms   max ${schedule.maxMs}ms`,
  );
  if (latency.overflow > 0) out.push(`  ! ${latency.overflow} samples exceeded 100s and are only counted, not timed`);
  if (schedule.p99Ms > config.thinkMedianMs) {
    out.push(
      `  ! schedule lag p99 (${schedule.p99Ms}ms) exceeds the think time — the harness could not keep its own cadence,`,
      `    so the OFFERED load was below the configured target for part of the run.`,
    );
  }
  out.push('');

  out.push(' ── PER PRINCIPAL ──────────────────────────────────────────────────────');
  for (const [kind, histogram] of Object.entries(aggregate.latencyByPrincipal)) {
    const s = summarize(histogram);
    if (s.count === 0) continue;
    out.push(
      `  ${kind.padEnd(16)} n=${String(s.count).padStart(7)}  p50 ${String(s.p50Ms).padStart(6)}ms  p95 ${String(s.p95Ms).padStart(7)}ms  p99 ${String(s.p99Ms).padStart(7)}ms`,
    );
  }
  out.push('');

  out.push(' ── FAILURES BY CAUSE ──────────────────────────────────────────────────');
  const failures = aggregate.total - aggregate.ok;
  if (failures === 0) {
    out.push(
      '  none.',
      '  This does NOT mean the platform has headroom — it means the offered load',
      '  never reached a ceiling. Raise users, lower think time, or use arrival=open.',
    );
  } else {
    const causes = Object.entries(aggregate.byCause).sort((a, b) => b[1] - a[1]);
    const worst = causes[0]?.[1] ?? 1;
    for (const [cause, count] of causes) {
      out.push(`  ${cause.padEnd(28)} ${String(count).padStart(7)}  ${pct(count, aggregate.total)}  ${bar(count, worst)}`);
    }
    out.push('', '  second level:');
    for (const [detail, count] of Object.entries(aggregate.byCauseDetail)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)) {
      out.push(`    ${String(count).padStart(7)}  ${detail}`);
    }
  }
  out.push('');

  out.push(' ── RATE-LIMIT LANE, PER TENANT ────────────────────────────────────────');
  for (const [tenantId, verdict] of Object.entries(report.lanes.byTenant)) {
    out.push(`  ${tenantId}  →  ${verdict.lane}${verdict.observedLimit === undefined ? '' : `   (enforced limit ${verdict.observedLimit}/window)`}`);
    for (const line of verdict.evidence) out.push(`      - ${line}`);
    if (verdict.lane === 'indeterminate')
      out.push('      every default-tier 429 for this tenant is reported `throttle_unknown`, not folded into a lane.');
  }
  out.push('  cross-tenant check:');
  for (const line of report.lanes.crossTenantEvidence) out.push(`      - ${line}`);
  if (aggregate.firstThrottleAtMs !== null) {
    out.push(`  first 429 at  ${(aggregate.firstThrottleAtMs / 1000).toFixed(1)}s into the run`);
    const before = aggregate.timeline.slice(0, Math.ceil(aggregate.firstThrottleAtMs / 1000)).reduce((sum, b) => sum + b.ok, 0);
    out.push(`  budget spent  ${before} successful requests before the first refusal`);
  }
  out.push('');

  out.push(' ── ENFORCED LIMITS SEEN ON 2xx ────────────────────────────────────────');
  const limits = Object.entries(aggregate.observedLimits).sort((a, b) => a[1] - b[1]);
  if (limits.length === 0) {
    out.push('  none advertised (no successful request carried X-RateLimit-Limit)');
  } else {
    for (const [route, limit] of limits.slice(0, 20)) out.push(`  ${String(limit).padStart(6)}/window  ${route}`);
  }
  out.push('');

  out.push(' ── TOP ROUTES ─────────────────────────────────────────────────────────');
  const routes = Object.entries(aggregate.byRoute)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 15);
  for (const [routeKey, stats] of routes) {
    const s = summarize(stats.latency);
    out.push(
      `  ${routeKey.padEnd(46).slice(0, 46)} n=${String(stats.total).padStart(7)}  fail ${pct(stats.failed, stats.total)}  p95 ${String(s.p95Ms).padStart(7)}ms`,
    );
  }
  out.push('');

  out.push(' ── PER TENANT ─────────────────────────────────────────────────────────');
  for (const [tenantId, stats] of Object.entries(aggregate.byTenant)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 12)) {
    out.push(`  ${tenantId.padEnd(40)} n=${String(stats.total).padStart(7)}  fail ${pct(stats.failed, stats.total)}`);
  }
  out.push('');

  out.push(' ── TIMELINE (requests/s, ▒ = throttled) ───────────────────────────────');
  const peak = Math.max(1, ...aggregate.timeline.map((b) => b.requests));
  const step = Math.max(1, Math.ceil(aggregate.timeline.length / 40));
  for (let i = 0; i < aggregate.timeline.length; i += step) {
    const window = aggregate.timeline.slice(i, i + step);
    const requests = window.reduce((sum, b) => sum + b.requests, 0) / window.length;
    const throttled = window.reduce((sum, b) => sum + b.throttled, 0) / window.length;
    if (requests === 0 && i > 0) continue;
    out.push(
      `  ${String(i).padStart(4)}s ${String(Math.round(requests)).padStart(5)}  ${bar(requests - throttled, peak)}${'▒'.repeat(Math.round((throttled / peak) * 28))}`,
    );
  }
  out.push('');

  if (report.metrics) {
    out.push(' ── GATEWAY /metrics (server-side view) ────────────────────────────────');
    if (report.metrics.note) out.push(`  ! ${report.metrics.note}`);
    out.push(`  requests seen by the gateway  ${report.metrics.totalRequests}   (client counted ${aggregate.total})`);
    const gap = aggregate.total - report.metrics.totalRequests;
    if (Math.abs(gap) > aggregate.total * 0.02) {
      out.push(
        `  ! the gateway counted ${gap} FEWER requests than the client issued.`,
        '    Expected, and itself a finding: Nest runs GUARDS before interceptors, so every request',
        '    the throttler or the auth guard refuses (429/401/403) never reaches the metrics',
        '    interceptor and is absent from api_gateway_http_requests_total. The server-side view is',
        '    therefore blind to exactly the traffic a capacity investigation cares about; trust the',
        '    client-side numbers above, and see the README for what this costs TASK-993 §2.10.',
      );
    }
    for (const [status, count] of Object.entries(report.metrics.requestsByStatus).sort()) out.push(`    HTTP ${status}  ${count}`);
    for (const [key, value] of Object.entries(report.metrics.endGauges)) out.push(`    ${key} = ${value}`);
    out.push('');
  }

  if (report.calibration) {
    const dropped = Object.entries(report.calibration.dropped).filter(([, list]) => list.length > 0);
    out.push(' ── CALIBRATION (routes dropped as unreachable before the run) ─────────');
    out.push(`  ${report.calibration.requestsSpent} probe requests spent`);
    if (dropped.length === 0) out.push('  every route in the mix was reachable by every credential group');
    for (const [groupKey, list] of dropped) {
      out.push(`  ${groupKey}`);
      for (const entry of list) out.push(`      - ${entry}`);
    }
    out.push('');
  }

  const binding = bindingCeiling(aggregate);
  out.push(' ── VERDICT ────────────────────────────────────────────────────────────');
  if (!binding) {
    out.push(
      '  No platform ceiling was reached at this load. The run bounds nothing —',
      '  it only shows the platform survived what was actually offered.',
    );
  } else {
    out.push(`  The binding ceiling was ${binding.cause} (${binding.count} refusals, ${pct(binding.count, aggregate.total)} of traffic).`);
    if (binding.cause === 'db_pool_timeout_suspected') {
      out.push(
        '  SUSPECTED, from latency alone: the gateway exports no pool metric. Settle it',
        `  against the gateway log using the ${aggregate.unattributedCorrelationIds.length} correlation ids in the JSON report.`,
      );
    }
  }
  const harnessFaults = (aggregate.byCause['auth'] ?? 0) + (aggregate.byCause['client_error'] ?? 0);
  if (harnessFaults > 0) {
    out.push(
      '',
      `  ! ${harnessFaults} responses were 401/403/4xx — HARNESS OR FIXTURE faults, excluded from the`,
      '    verdict. A non-trivial count means the run did not exercise what it claims to.',
    );
  }
  out.push('════════════════════════════════════════════════════════════════════════', '');

  return out.join('\n');
}
