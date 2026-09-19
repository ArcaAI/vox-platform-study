/**
 * Find out, before the timed run, which routes each credential can actually
 * reach — and drop the rest.
 *
 * ## Why this exists
 *
 * The first smoke run against the dev gateway returned **63 of 96 responses as
 * 403**, because the fallback fixture's users hold DOCTOR and the screen mix is
 * a platform admin's. Every one of those 403s was correctly excluded from the
 * verdict as a harness fault, which is the right behaviour — and it also meant
 * two thirds of the offered load exercised the authorization guard instead of
 * the ceilings under test. A run can be perfectly honest and still measure the
 * wrong thing.
 *
 * Encoding "which role can see which screen" in the mix would be the obvious
 * fix and the wrong one: it hard-codes an assumption about the fixture that
 * silently rots the moment someone seeds a different role. Asking the platform
 * instead costs one request per (credential class, tenant, route) and is
 * correct for whatever fixture actually exists.
 *
 * ## Free side effect
 *
 * It warms the API-key lane. `TieredThrottlerGuard` resolves an API key's
 * tenant from a Redis hint published on the PREVIOUS successful
 * authentication, so an un-warmed key rides the platform lane on its first
 * request of each TTL window and advertises the wrong limit.
 *
 * ## Cost, and why the cooldown after it is not optional
 *
 * Calibration spends real budget on live counters — roughly one request per
 * distinct route per group. Starting the timed run immediately would begin it
 * with a partly-spent bucket, which corrupts the single most useful number the
 * run produces: how much successful traffic fit before the first refusal. The
 * caller waits out one limiter window afterwards.
 */
import { issue, type Credential } from './http';
import { stepsFor } from './scenario';
import type { PrincipalKind, Screen, ScreenStep } from './types';

export interface CalibrationOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly pgConnectTimeoutMs: number;
  readonly t0Ms: number;
}

/** Group key: reachability is a property of (credential class, tenant), not of an individual principal. */
export function groupKeyOf(kind: PrincipalKind, tenantId: string): string {
  return `${kind}|${tenantId}`;
}

export interface Calibration {
  /** group key → the route keys that group may issue. */
  readonly allowed: Readonly<Record<string, readonly string[]>>;
  /** group key → `route (reason)` for everything dropped, printed in the report. */
  readonly dropped: Readonly<Record<string, readonly string[]>>;
  readonly requestsSpent: number;
}

/** A step is unreachable when the platform refuses it for a reason that will not change under load. */
function unreachable(status: number | null): string | null {
  if (status === 401) return '401 unauthenticated';
  if (status === 403) return '403 not permitted for this credential';
  // 404 on an admin route is the house 404-over-403 posture, i.e. "not yours".
  if (status === 404) return '404 not visible to this tenant';
  // A 400 means the harness sent a malformed body — a bug here, not a finding there.
  if (status === 400) return '400 the harness step is malformed';
  return null;
}

function distinctSteps(screens: readonly Screen[], kind: PrincipalKind): ScreenStep[] {
  const seen = new Map<string, ScreenStep>();
  for (const screen of screens) {
    for (const step of stepsFor(screen, kind)) {
      const key = `${step.method} ${step.path}`;
      if (!seen.has(key)) seen.set(key, step);
    }
  }
  return [...seen.values()];
}

/**
 * Probe one representative credential per group.
 *
 * A 429 during calibration is NOT treated as unreachable — it is the ceiling
 * under test, and dropping a route because the limiter was already busy would
 * remove the very traffic the run exists to generate.
 */
export async function calibrate(
  options: CalibrationOptions,
  credentials: readonly Credential[],
  consoleScreens: readonly Screen[],
  machineScreens: readonly Screen[],
): Promise<Calibration> {
  const representative = new Map<string, Credential>();
  for (const credential of credentials) {
    const key = groupKeyOf(credential.kind, credential.tenantId);
    if (!representative.has(key)) representative.set(key, credential);
  }

  const allowed: Record<string, string[]> = {};
  const dropped: Record<string, string[]> = {};
  let requestsSpent = 0;

  for (const [key, credential] of representative) {
    const steps = distinctSteps(credential.kind === 'human' ? consoleScreens : machineScreens, credential.kind);
    allowed[key] = [];
    dropped[key] = [];

    for (const step of steps) {
      const result = await issue({
        baseUrl: options.baseUrl,
        credential,
        method: step.method,
        path: step.path,
        routeKey: step.path.split('?')[0],
        body: step.body,
        timeoutMs: options.timeoutMs,
        pgConnectTimeoutMs: options.pgConnectTimeoutMs,
        t0Ms: options.t0Ms,
      });
      requestsSpent += 1;

      const reason = unreachable(result.sample.status);
      const routeKey = `${step.method} ${step.path}`;
      if (reason) dropped[key]!.push(`${routeKey} (${reason})`);
      else allowed[key]!.push(routeKey);
    }
  }

  return { allowed, dropped, requestsSpent };
}

/**
 * Rebuild the screen mix with the unreachable steps removed.
 *
 * A screen left with no reachable step is dropped entirely rather than kept as
 * a zero-cost navigation, so the weights still describe what the run does.
 */
export function applyCalibration(screens: readonly Screen[], allowedRouteKeys: readonly string[]): Screen[] {
  const allowed = new Set(allowedRouteKeys);
  return screens
    .map((screen) => ({ ...screen, steps: screen.steps.filter((step) => allowed.has(`${step.method} ${step.path}`)) }))
    .filter((screen) => screen.steps.length > 0);
}

/** The shell steps a human still pays, after calibration. */
export function allowedShellSteps(shell: readonly ScreenStep[], allowedRouteKeys: readonly string[]): ScreenStep[] {
  const allowed = new Set(allowedRouteKeys);
  return shell.filter((step) => allowed.has(`${step.method} ${step.path}`));
}
