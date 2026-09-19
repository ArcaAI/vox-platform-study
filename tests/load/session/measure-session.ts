/**
 * ENTRY POINT 1 — measure what ONE real console session actually costs.
 *
 * TASK-993 §1 states a load model of ~10 req/min per active user; OD-1 revised
 * it to ~30-50 because a screen fires 10-15 TanStack queries. Both numbers are
 * assumptions. Every capacity figure in §2.9 is scaled from one of them, so
 * until one is measured the whole table rests on an estimate.
 *
 * This script replaces the estimate. It drives the REAL admin console in a real
 * Chromium, logs in as a real seeded user, walks real screens, and counts the
 * requests that actually reach the gateway. Nothing about the console's query
 * fan-out, its `staleTime` de-duplication, its shell tax or its `refetchInterval`
 * polls is modelled — it is observed.
 *
 * Why a browser and not a route list: the thing under measurement IS the
 * console's behaviour. A hand-written route list measures the list.
 *
 * ## Run
 *
 *     pnpm load:session                      # against the running dev console
 *     LOAD_HEADED=1 pnpm load:session        # watch it
 *     LOAD_CONSOLE_URL=… LOAD_USERNAME=… LOAD_PASSWORD=… pnpm load:session
 *
 * Needs: the admin console (5176) and the gateway (8868) up, and a seeded user.
 * It writes `tests/load/results/session-profile.json`, which `run-load.ts`
 * consumes as its route mix.
 *
 * ## What is counted
 *
 * A request counts when it will cost the GATEWAY a request:
 *   - `/api/hope/*`  — the BFF catch-all; one browser call ⇒ one gateway call.
 *   - `/api/auth/*`  — except `session` and `working-tenant`, which the BFF
 *                      answers from the cookie with no gateway hop.
 *   - anything to the gateway origin directly (SSE, WS ticket redemption).
 * Next.js assets, RSC payloads and `_next/*` are not gateway traffic and are
 * counted separately so the ratio is visible rather than hidden.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { SessionProfile } from '../src/scenario';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(HERE, '..', 'results');

const CONSOLE_URL = process.env.LOAD_CONSOLE_URL ?? 'http://localhost:5176';
const GATEWAY_URL = process.env.LOAD_BASE_URL ?? 'http://localhost:8868';
const USERNAME = process.env.LOAD_USERNAME ?? 'super_admin';
const PASSWORD = process.env.LOAD_PASSWORD ?? 'password123';
const TENANT_KEY = process.env.LOAD_TENANT_KEY ?? '';
const HEADED = process.env.LOAD_HEADED === '1';

/** ms to let a screen's queries and any SSE settle before moving on. */
const SETTLE_MS = Number(process.env.LOAD_SETTLE_MS ?? 4_000);
/** ms to sit still on the landing screen, to catch `refetchInterval` polls. Must exceed the 30 s console poll. */
const IDLE_MS = Number(process.env.LOAD_IDLE_MS ?? 70_000);

/**
 * The walk.
 *
 * Chosen as the screens a platform admin opens first, per the nav inventory in
 * `shared/navigation/nav-config.ts`. Override with a comma-separated
 * `LOAD_SCREENS`.
 */
// Clustered BY NAV DOMAIN on purpose. The sidebar only renders the active
// domain's entries, so a walk that jumps between domains can only ever measure
// document loads. Grouping means the first screen of each domain is a document
// load and its siblings are client-side clicks — which is both what a real
// admin does and the only way to get both halves of the range.
const DEFAULT_WALK = [
  '/dashboard',
  '/monitoring',
  '/releases',
  '/tenants',
  '/entitlements',
  '/features',
  '/rate-limits',
  '/queues',
  '/audit-logs',
  '/users',
  '/rbac/roles',
];
const WALK = (process.env.LOAD_SCREENS ?? DEFAULT_WALK.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

interface Observed {
  readonly at: number;
  readonly method: string;
  readonly url: string;
  readonly kind: 'gateway' | 'bff-local' | 'asset';
  readonly phase: string;
  readonly status: number | null;
}

/**
 * HARD vs SOFT navigation, and why both are measured.
 *
 * A `page.goto` is a full document load: the React tree is destroyed and the
 * TanStack `QueryClient` with it, so every shell query — permission checks,
 * feature gates, the tenant catalogue — is re-fetched no matter how fresh it
 * was. That is an UPPER bound on what a navigation costs.
 *
 * A real user clicks a `<Link>`. The App Router swaps the segment, the
 * QueryClient survives, and `staleTime: 30_000` suppresses every shell query
 * that ran in the last 30 seconds. That is the LOWER bound, and the one a
 * steady-state population actually produces.
 *
 * The honest answer is a range, so the walk tries a real link click first and
 * only falls back to `goto` when the target is not reachable from the current
 * sidebar (a different domain in the rail). Both are counted separately.
 */
type NavKind = 'soft' | 'hard';

/**
 * Where a browser request lands.
 *
 * `/api/auth/session` and `/api/auth/working-tenant` are answered from the
 * sealed cookie and never reach the gateway — counting them would inflate the
 * headline number, which is the one thing this script exists to get right.
 */
const BFF_LOCAL_ONLY = ['/api/auth/session', '/api/auth/working-tenant'];

function classify(url: string): Observed['kind'] {
  if (url.startsWith(GATEWAY_URL)) return 'gateway';
  const path = url.startsWith(CONSOLE_URL) ? url.slice(CONSOLE_URL.length) : url;
  if (BFF_LOCAL_ONLY.some((p) => path.startsWith(p))) return 'bff-local';
  if (path.startsWith('/api/hope/') || path.startsWith('/api/auth/')) return 'gateway';
  return 'asset';
}

/**
 * Route template for the mix.
 *
 * Strips the proxy mount, the query string, and any UUID or long hex segment —
 * otherwise a mix keyed on resolved URLs has unbounded cardinality and tells
 * you nothing.
 */
function templateFor(method: string, url: string): string {
  let path = url.startsWith(CONSOLE_URL) ? url.slice(CONSOLE_URL.length) : url.startsWith(GATEWAY_URL) ? url.slice(GATEWAY_URL.length) : url;
  path = path.split('?')[0] ?? path;
  path = path
    .replace(/^\/api\/hope\//, '')
    .replace(/^\/api\/v1\//, '')
    .replace(/^\//, '');
  path = path
    .split('/')
    .map((segment) => (/^[0-9a-f-]{16,}$/i.test(segment) ? ':id' : segment))
    .join('/');
  return `${method} ${path}`;
}

async function login(page: Page): Promise<void> {
  await page.goto(`${CONSOLE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', USERNAME);
  await page.fill('#login-password', PASSWORD);
  if (TENANT_KEY) await page.fill('#login-tenant-key', TENANT_KEY);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

async function main(): Promise<void> {
  const observed: Observed[] = [];
  let phase = 'startup';

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: !HEADED });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();

    // `request` rather than `response`: a request that never answers still cost
    // the gateway a connection, and the run must not lose it.
    page.on('request', (request) => {
      observed.push({ at: Date.now(), method: request.method(), url: request.url(), kind: classify(request.url()), phase, status: null });
    });

    phase = 'login';
    await login(page);
    await page.waitForTimeout(SETTLE_MS);

    const navigationPhases: Array<{ phase: string; kind: NavKind }> = [];
    for (const screen of WALK) {
      // A client-side click when the link is on screen; a document load when it
      // is not. Which one happened is recorded, never assumed.
      const link = page.locator(`a[href="${screen}"]`).first();
      const soft = (await link.count()) > 0 && (await link.isVisible().catch(() => false));
      const kind: NavKind = soft ? 'soft' : 'hard';
      phase = `nav:${kind}:${screen}`;
      navigationPhases.push({ phase, kind });

      if (soft) {
        await link.click();
        await page.waitForURL((url) => url.pathname === screen, { timeout: 30_000 }).catch(() => undefined);
      } else {
        await page.goto(`${CONSOLE_URL}${screen}`, { waitUntil: 'domcontentloaded' });
      }
      await page.waitForTimeout(SETTLE_MS);
    }

    // Park. This is where `refetchInterval` shows itself: no user input at all,
    // and the console still talks. TASK-993 §2.12's reconnect storm is the same
    // class of traffic — load a platform never attributed to anybody.
    phase = 'idle';
    const idleStart = Date.now();
    await page.goto(`${CONSOLE_URL}${WALK[0] ?? '/dashboard'}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(IDLE_MS);
    const idleMs = Date.now() - idleStart;

    await context.close();

    report(observed, navigationPhases, idleMs);
  } finally {
    await browser?.close();
  }
}

function report(observed: Observed[], navigationPhases: ReadonlyArray<{ phase: string; kind: NavKind }>, idleMs: number): void {
  const gateway = observed.filter((o) => o.kind === 'gateway');
  const assets = observed.filter((o) => o.kind === 'asset');
  const bffLocal = observed.filter((o) => o.kind === 'bff-local');

  const idle = gateway.filter((o) => o.phase === 'idle');
  const navs = gateway.filter((o) => o.phase.startsWith('nav:'));
  const loginPhase = gateway.filter((o) => o.phase === 'login');

  const softPhases = navigationPhases.filter((n) => n.kind === 'soft');
  const hardPhases = navigationPhases.filter((n) => n.kind === 'hard');
  const softRequests = gateway.filter((o) => o.phase.startsWith('nav:soft:')).length;
  const hardRequests = gateway.filter((o) => o.phase.startsWith('nav:hard:')).length;
  const perSoftNav = softPhases.length > 0 ? softRequests / softPhases.length : Number.NaN;
  const perHardNav = hardPhases.length > 0 ? hardRequests / hardPhases.length : Number.NaN;

  const activeSamples = [...loginPhase, ...navs];
  const activeSpanMs = activeSamples.length > 1 ? activeSamples[activeSamples.length - 1]!.at - activeSamples[0]!.at : 1;

  const counts = new Map<string, number>();
  for (const sample of gateway) {
    const key = templateFor(sample.method, sample.url);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const routeMix = Object.fromEntries(
    [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => [key, Number((count / gateway.length).toFixed(4))]),
  );

  const perNavigation = navigationPhases.length > 0 ? navs.length / navigationPhases.length : 0;
  const idlePerMinute = idleMs > 0 ? (idle.length / idleMs) * 60_000 : 0;
  const activePerMinute = (activeSamples.length / activeSpanMs) * 60_000;

  const profile: SessionProfile = {
    source: 'measured',
    recordedAt: new Date().toISOString(),
    requestsPerMinute: Number(activePerMinute.toFixed(1)),
    requestsPerNavigation: Number(perNavigation.toFixed(2)),
    idleRequestsPerMinute: Number(idlePerMinute.toFixed(1)),
    routeMix,
    notes: [
      `walked ${navigationPhases.length} screens (${softPhases.length} client-side, ${hardPhases.length} document loads)`,
      Number.isFinite(perSoftNav)
        ? `client-side navigation: ${perSoftNav.toFixed(2)} gateway requests each`
        : 'no client-side navigation was possible in this walk',
      Number.isFinite(perHardNav)
        ? `document load: ${perHardNav.toFixed(2)} gateway requests each (the TanStack cache is destroyed, so every shell query re-runs)`
        : '',
      `settle ${SETTLE_MS}ms per screen, idle window ${Math.round(idleMs / 1000)}s`,
      `${assets.length} asset/RSC requests and ${bffLocal.length} cookie-only BFF calls were NOT counted as gateway load`,
      'the ACTIVE rate is an upper bound: it assumes a user who navigates continuously with no reading pause beyond the settle window',
      'SSE/WS byte traffic is not counted — only the requests that open and re-open those streams',
    ].filter(Boolean),
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const profilePath = resolve(RESULTS_DIR, 'session-profile.json');
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  writeFileSync(
    resolve(RESULTS_DIR, 'session-requests.json'),
    `${JSON.stringify(
      observed.map((o) => ({ ...o, template: templateFor(o.method, o.url) })),
      null,
      2,
    )}\n`,
  );

  const lines = [
    '',
    '══ ONE CONSOLE SESSION, MEASURED ═══════════════════════════════════════',
    `  gateway-bound requests        ${gateway.length}`,
    `  ... of which during idle      ${idle.length} over ${Math.round(idleMs / 1000)}s`,
    `  asset / RSC requests          ${assets.length}  (not gateway load)`,
    `  cookie-only BFF calls         ${bffLocal.length}  (not gateway load)`,
    '',
    `  ACTIVE   ${profile.requestsPerMinute.toFixed(1)} req/min per user   <-- the OD-1 number`,
    `  IDLE     ${profile.idleRequestsPerMinute.toFixed(1)} req/min per parked session`,
    `  BURST    ${profile.requestsPerNavigation.toFixed(1)} requests per navigation (all)`,
    `           ${Number.isFinite(perSoftNav) ? perSoftNav.toFixed(1) : 'n/a'} client-side  /  ${Number.isFinite(perHardNav) ? perHardNav.toFixed(1) : 'n/a'} document load`,
    '',
    '  top routes by share',
    ...Object.entries(routeMix)
      .slice(0, 15)
      .map(([route, share]) => `    ${(share * 100).toFixed(1).padStart(5)}%  ${route}`),
    '',
    `  written to ${profilePath}`,
    '',
  ];
  console.log(lines.join('\n'));
}

main().catch((error: unknown) => {
  console.error('[load:session] failed:', error);
  process.exitCode = 1;
});
