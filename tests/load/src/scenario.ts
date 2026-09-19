/**
 * What a virtual user DOES.
 *
 * The screen list below is the STATIC fallback — derived by reading
 * `apps/admin-console/src/features/**` and recording which TanStack queries
 * each screen fires on mount. It exists so the driver can run before anyone has
 * recorded a session, and so a code review can see the model rather than a
 * number.
 *
 * It is NOT the authority. `session/measure-session.ts` drives the real console
 * in a real browser and writes a `SessionProfile` to
 * `tests/load/results/session-profile.json`; `loadProfile()` prefers that file
 * whenever it exists. TASK-993 OD-1 was answered "3x headroom, then load-test
 * to confirm", and confirming against a hand-written mix would just re-confirm
 * the hand-written mix.
 *
 * ## The two things the mix has to get right
 *
 * 1. **Burstiness.** A navigation fires its whole query set within a few
 *    hundred ms. Spreading those requests evenly over the think time would
 *    halve the peak the limiter sees and quietly move the breaking point.
 * 2. **The shell tax.** Every navigation also pays `POST
 *    users/me/permission-checks` and (when the 30 s cache has expired)
 *    `GET admin/settings/features/effective`. Omitting the shell understates a
 *    real session by roughly one request per navigation.
 */
import type { PrincipalKind, Screen, ScreenStep } from './types';

/** Fired on EVERY console navigation by the shell, before the screen's own queries. */
export const SHELL_STEPS: readonly ScreenStep[] = [
  // Deduped across the 4+ shell consumers by TanStack, so exactly one per page load.
  { method: 'POST', path: 'users/me/permission-checks', body: { checks: [] }, principals: ['human'] },
  // `staleTime: 30_000`, so a user navigating faster than that pays it once per 30 s.
  // Modelled unconditionally: it is one request and over-counting the shell is the
  // safe direction for a capacity question.
  { method: 'GET', path: 'admin/settings/features/effective', principals: ['human'] },
];

/**
 * The static fallback mix.
 *
 * Weights approximate where a platform admin actually spends time: the landing
 * dashboard and the list screens dominate; the configuration screens are opened
 * occasionally. They are a model, and the recorder replaces them.
 */
export const CONSOLE_SCREENS: readonly Screen[] = [
  {
    name: 'dashboard',
    weight: 20,
    steps: [
      { method: 'GET', path: 'admin/platform/metrics' },
      { method: 'GET', path: 'admin/health/services' },
      { method: 'GET', path: 'admin/audit-logs?limit=10' },
    ],
  },
  {
    name: 'monitoring',
    weight: 10,
    steps: [
      { method: 'GET', path: 'admin/health/services' },
      { method: 'GET', path: 'admin/monitoring/uptime' },
      { method: 'GET', path: 'admin/monitoring/sessions' },
      { method: 'GET', path: 'admin/queues/health/redis' },
    ],
  },
  {
    name: 'tenants',
    weight: 14,
    steps: [
      { method: 'GET', path: 'admin/tenants?page=1&limit=25' },
      { method: 'GET', path: 'users/me/settings' },
    ],
  },
  {
    name: 'users',
    weight: 14,
    steps: [
      { method: 'GET', path: 'admin/users?page=1&limit=25' },
      { method: 'GET', path: 'admin/tenants?limit=500' },
      { method: 'GET', path: 'users/me/settings' },
    ],
  },
  {
    name: 'audit-logs',
    weight: 12,
    steps: [
      { method: 'GET', path: 'admin/audit-logs/cursor?limit=50' },
      { method: 'GET', path: 'admin/audit-logs?limit=1' },
      { method: 'GET', path: 'admin/tenants?limit=500' },
      { method: 'GET', path: 'users/me/settings' },
    ],
  },
  {
    name: 'queues',
    weight: 8,
    steps: [{ method: 'GET', path: 'admin/queues' }],
  },
  {
    name: 'entitlements',
    weight: 6,
    steps: [
      { method: 'GET', path: 'admin/entitlements/enabled' },
      { method: 'GET', path: 'admin/entitlements/plans' },
    ],
  },
  {
    name: 'rate-limits',
    weight: 6,
    steps: [{ method: 'GET', path: 'admin/rate-limit' }],
  },
  {
    name: 'releases',
    weight: 5,
    steps: [
      { method: 'GET', path: 'admin/service-releases/current?environment=development' },
      { method: 'GET', path: 'admin/service-releases?limit=50' },
    ],
  },
  {
    name: 'features',
    weight: 5,
    steps: [{ method: 'GET', path: 'admin/settings/features/matrix' }],
  },
];

/**
 * The machine plane.
 *
 * Integrations do not navigate: they poll a small set of routes steadily. They
 * are here because they share the tenant's bucket — `TieredThrottlerGuard` keys
 * ranks 1-3 as `t:<tenantId>` with no principal component — so leaving them out
 * would overstate the budget available to humans.
 */
export const MACHINE_SCREENS: readonly Screen[] = [
  {
    name: 'integration-poll',
    weight: 70,
    steps: [
      { method: 'GET', path: 'agents' },
      { method: 'GET', path: 'workflows' },
    ],
  },
  {
    name: 'integration-admin-read',
    weight: 30,
    steps: [{ method: 'GET', path: 'admin/tenants?limit=25', principals: ['service_account'] }],
  },
];

/** A recorded (or fallback) model of what one session costs. The unit the whole report is scaled from. */
export interface SessionProfile {
  /** `measured` when produced by `measure-session.ts`; `static-fallback` when read off this file. */
  readonly source: 'measured' | 'static-fallback';
  readonly recordedAt?: string;
  /** THE number OD-1 asked for: gateway requests per minute for one active console user. */
  readonly requestsPerMinute: number;
  /** Requests in the burst that follows one navigation, shell included. */
  readonly requestsPerNavigation: number;
  /** Requests a parked session still issues, from `refetchInterval` polls alone. */
  readonly idleRequestsPerMinute: number;
  /** Route template → share of total requests. */
  readonly routeMix: Readonly<Record<string, number>>;
  readonly notes: readonly string[];
}

/**
 * Derive the fallback profile from the screen table, so the two can never drift.
 *
 * `navigationsPerMinute` is the only free parameter: at a 4 s median think time
 * plus roughly 1 s of page settling, a continuously active user navigates about
 * 12 times a minute. That is an ACTIVE user; §"What this cannot tell you" in the
 * README is explicit that a real population is not continuously active.
 */
export function staticFallbackProfile(navigationsPerMinute = 12): SessionProfile {
  const totalWeight = CONSOLE_SCREENS.reduce((sum, s) => sum + s.weight, 0);
  const weightedSteps = CONSOLE_SCREENS.reduce((sum, s) => sum + s.weight * s.steps.length, 0) / totalWeight;
  const perNavigation = weightedSteps + SHELL_STEPS.length;

  // Poll traffic a parked session still produces: dashboard 2/30s, monitoring
  // 4/30s, queues 1/15s — weighted by how often a user is on each.
  const idlePerMinute = (20 / totalWeight) * (2 * 2) + (10 / totalWeight) * (4 * 2) + (8 / totalWeight) * (1 * 4);

  const counts = new Map<string, number>();
  for (const screen of CONSOLE_SCREENS) {
    for (const step of [...SHELL_STEPS, ...screen.steps]) {
      const key = `${step.method} ${step.path.split('?')[0]}`;
      counts.set(key, (counts.get(key) ?? 0) + screen.weight);
    }
  }
  const grand = [...counts.values()].reduce((a, b) => a + b, 0);
  const routeMix = Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Number((v / grand).toFixed(4))]));

  return {
    source: 'static-fallback',
    requestsPerMinute: Number((perNavigation * navigationsPerMinute + idlePerMinute).toFixed(1)),
    requestsPerNavigation: Number(perNavigation.toFixed(2)),
    idleRequestsPerMinute: Number(idlePerMinute.toFixed(1)),
    routeMix,
    notes: [
      'DERIVED FROM SOURCE, NOT MEASURED. Run `pnpm load:session` to replace it.',
      `assumes ${navigationsPerMinute} navigations/min for a continuously active user`,
      'excludes POST /api/auth/refresh (one per 15 min per browser tab)',
      'excludes SSE/WS, which bypass the BFF and connect straight to the gateway',
    ],
  };
}

/** Pick a screen by weight. Pure, so the mix is reproducible from the seed. */
export function pickScreen(screens: readonly Screen[], random: () => number): Screen {
  const total = screens.reduce((sum, s) => sum + s.weight, 0);
  let roll = random() * total;
  for (const screen of screens) {
    roll -= screen.weight;
    if (roll <= 0) return screen;
  }
  return screens[screens.length - 1]!;
}

/** The steps a principal of `kind` actually issues for `screen`, shell included for humans. */
export function stepsFor(screen: Screen, kind: PrincipalKind): readonly ScreenStep[] {
  const shell = kind === 'human' ? SHELL_STEPS : [];
  return [...shell, ...screen.steps].filter((step) => step.principals === undefined || step.principals.includes(kind));
}

/** Strip the query string so the report keys on a bounded set of route templates. */
export function routeTemplate(method: string, path: string): string {
  return `${method} ${path.split('?')[0]}`;
}
