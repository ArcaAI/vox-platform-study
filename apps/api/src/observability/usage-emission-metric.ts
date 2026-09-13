/**
 * The alertable half of "this usage was NOT billed".
 *
 * TASK-957 F-5's finding was that a lost emission surfaces ONLY as a `warn` line — invisible to
 * an alert and indistinguishable from noise at request volume. The gateway's trajectory lane
 * answered that with {@link USAGE_EMISSION_FAILED_METRIC}; every other emitter still warns and
 * moves on. This module is that counter, reachable from the controllers that emit outside the
 * applications layer's own services.
 *
 * ============================================================================
 * WHY IT IS RESOLVED LAZILY, AND FROM THE PROCESS-GLOBAL REGISTER
 * ============================================================================
 * `AgentTrajectoryService` registers the SAME counter through `IMetricsService` at DI
 * construction. Two registrations of one name is a prom-client throw, and `MetricsService`
 * re-throws it, so a module-level `new Counter(...)` here would run at IMPORT time — before DI —
 * and take that lane's counter away from it. Resolving at INCREMENT time (a request, always
 * after boot) finds the registered instance instead; only when nothing registered it does this
 * create it, and then with the identical label set so the two can never disagree.
 *
 * `reason` IS a label, and it is the one shared with the harness half of this counter
 * (`apps/harness/src/harness/core/metrics.py`): the worker answers `rejected` | `spooled` |
 * `dropped`, the gateway `dropped` (an emission that threw and had no spool to fall into) |
 * `unattributable` (a row the gateway refused to guess — TASK-957 F-10). prom-client THROWS on
 * a label outside the initial set, which is why the set below must match the service's exactly.
 */
import { USAGE_EMISSION_FAILED_METRIC } from '@arcaai/applications';
import { Counter, register } from 'prom-client';

/** Label set — must match `AgentTrajectoryService.registerEmissionFailedCounter` exactly. */
const LABEL_NAMES = ['operation', 'trigger', 'reason'] as const;

function resolveCounter(): Counter<string> | null {
  const existing = register.getSingleMetric(USAGE_EMISSION_FAILED_METRIC);
  if (existing) return existing instanceof Counter ? existing : null;
  return new Counter({
    name: USAGE_EMISSION_FAILED_METRIC,
    help: 'Usage-ledger emissions that never reached the ledger. Non-zero means metered work was NOT billed.',
    labelNames: [...LABEL_NAMES],
    registers: [register],
  });
}

/**
 * Record that one usage emission did NOT reach the ledger.
 *
 * Covers both shapes of "not billed": an emission that THREW, and one this gateway
 * deliberately refused to write because it could not attribute it honestly (TASK-957 F-10 — a
 * TTS row whose provider the service never named). Both are metered work with no revenue behind
 * it, which is the one question this counter exists to answer.
 *
 * Never throws: a metric that breaks the request it is observing is worse than a missing sample.
 */
export type UsageEmissionFailureReason = 'dropped' | 'unattributable';

export function recordUsageEmissionFailure(operation: string, reason: UsageEmissionFailureReason, trigger?: string): void {
  try {
    // `none` rather than an absent label, as the service half does: a blank facet is
    // unfilterable, and an absent trigger is a real answer.
    resolveCounter()?.inc({ operation, trigger: trigger ?? 'none', reason });
  } catch {
    // A registry conflict or a label mismatch must not reach the caller — the `warn` line beside
    // every call site is the fallback record.
  }
}
