/**
 * Route Authorization Conformance Matrix (table-driven)
 *
 * Walks EVERY route in `apps/api/route-manifest.json` and proves the RUNTIME behavior of
 * `UnifiedAuthGuard` agrees with the DECLARED metadata. The manifest is emitted through the
 * same reflector lookups the guard performs, so a disagreement between the two is either a
 * guard regression or a decorator that does not do what it claims.
 *
 * Five assertions, all derived per-route from manifest fields:
 *   A1 NO-CREDENTIAL isPublic=false -> 401 unauthenticated
 *   A2 API-KEY FORBIDDEN apiKeyForbidden=true -> 403 for a VALID API key
 *   A3 SVC FORBIDDEN forbidServiceAccount=true -> 403 for a VALID SA token
 *   A4 SVC UNDECLARED !public && svcScopes=[] && !forbid -> 403 (deny-by-default)
 *   A5 PUBLIC isPublic=true -> NOT 401 without credentials
 *
 * Why this is safe against a live DB: every assertion expects a REJECTION (401/403), which the
 * guard returns BEFORE the handler runs. No mutating handler is ever reached. If a route DOES
 * return 2xx, that is the finding — it is recorded and never retried.
 *
 * Path params are substituted with a well-formed but non-existent UUID, so a 404 is an
 * expected, safe outcome. Assertions therefore check for the SPECIFIC rejection code, never
 * merely "not 200".
 *
 * Prerequisites: API server running (default http://localhost:8968/api/v1), DB seeded.
 */

import { test, expect } from '@playwright/test';
import { SEEDED_USERS, SEEDED_API_KEY } from '../../../../tests/helpers';
import {
  loadRouteManifest,
  substitutePathParams,
  routeLabel,
  skipReasonFor,
  isStreamingRoute,
  type ManifestRoute,
} from './helpers/route-manifest.helper';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_ORIGIN = (process.env.API_URL || 'http://localhost:8968/api/v1').replace(/\/api\/v1\/?$/, '');
const CONCURRENCY = 24;
const REQUEST_TIMEOUT_MS = 10_000;

const SERVICE_ACCOUNT_CLIENT_ID = 'hope_svc_a4ca1a11ad3141b0c0de0001';
const SERVICE_ACCOUNT_CLIENT_SECRET = 'hope_svcsec_test_4f0b1d7a2e6c48b39a15d0c7e2f83b6104d9a7c5e18f2b6039d4c8a71e0b5f2d';

type CredentialClass = 'none' | 'apiKey' | 'serviceAccount';

interface Probe {
  route: ManifestRoute;
  credential: CredentialClass;
  status: number; // -1 = transport error / timeout
  body: string; // first 300 chars — distinguishes a GUARD rejection from a handler-level one
  error?: string;
}

const manifest = loadRouteManifest();
const allRoutes = manifest.routes;

const skips = new Map<string, string>();
const sweptRoutes = allRoutes.filter((r) => {
  const reason = skipReasonFor(r);
  if (reason) {
    skips.set(routeLabel(r), reason);
    return false;
  }
  return true;
});

// ---------------------------------------------------------------------------
// Probe execution — one shared sweep for the whole file
// ---------------------------------------------------------------------------

const results = new Map<string, Probe>();
const probeKey = (r: ManifestRoute, c: CredentialClass) => `${c}::${r.method} ${r.path}`;

let apiKey = '';
let serviceAccountToken = '';

function headersFor(credential: CredentialClass): Record<string, string> {
  const base: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (credential === 'apiKey') base['X-API-Key'] = apiKey;
  if (credential === 'serviceAccount') base['X-Service-Account-Token'] = serviceAccountToken;
  return base;
}

async function runProbe(route: ManifestRoute, credential: CredentialClass): Promise<Probe> {
  const url = API_ORIGIN + substitutePathParams(route.path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: route.method,
      headers: headersFor(credential),
      body: route.method === 'GET' || route.method === 'DELETE' ? undefined : '{}',
      signal: controller.signal,
      redirect: 'manual',
    });
    // Drain the body so streaming responses do not keep the socket open.
    let body = '';
    if (isStreamingRoute(route)) {
      await res.body?.cancel().catch(() => undefined);
    } else {
      body = (await res.text().catch(() => '')).slice(0, 300);
    }
    return { route, credential, status: res.status, body };
  } catch (err) {
    return { route, credential, status: -1, body: '', error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function runAll(jobs: Array<[ManifestRoute, CredentialClass]>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const [route, credential] = jobs[i];
      const probe = await runProbe(route, credential);
      results.set(probeKey(route, credential), probe);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Case selection (derived purely from manifest fields)
// ---------------------------------------------------------------------------

const casesA1 = sweptRoutes.filter((r) => !r.isPublic);

/**
 * A2 carve-out — `@Public()` short-circuits `UnifiedAuthGuard` entirely, so a `@ForbidApiKey()`
 * on the SAME route is structurally unenforceable: there is no code path that can return 403.
 * These are declaration-hygiene findings, not runtime regressions (all six are unauthenticated
 * endpoints that expose nothing privileged), so they are asserted separately as an EXACT,
 * frozen inventory — a seventh such route must fail this suite rather than slip in silently.
 */
const INERT_FORBID_API_KEY = [
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'GET /api/v1/health',
  'GET /api/v1/health/live',
  'GET /api/v1/health/ready',
  'GET /api/v1/health/startup',
];
const casesA2All = sweptRoutes.filter((r) => r.apiKeyForbidden);
const casesA2 = casesA2All.filter((r) => !r.isPublic);
const casesA2Inert = casesA2All.filter((r) => r.isPublic);
const casesA3 = sweptRoutes.filter((r) => r.forbidServiceAccount);
const casesA4 = sweptRoutes.filter((r) => !r.isPublic && !r.forbidServiceAccount && (r.svcScopes?.length ?? 0) === 0);
/**
 * A5 splits by WHICH gate is in play, because `isPublic` records only what
 * `UnifiedAuthGuard` sees:
 *
 *  - `casesA5` — genuinely public: the unified guard is the only auth gate, so an
 *    unauthenticated request must never be rejected BY THE GUARD. A handler-level 401
 *    (e.g. `/auth/sso/callback` rejecting an absent SSO state) still proves the route was
 *    REACHED, which is what "public" means — so the predicate looks at the body, not just
 *    the status.
 *  - `casesA5Internal` — `@Public()` + a route-level service-token guard
 *    (`HarnessServiceTokenGuard` and friends over `X-Service-Token`). `@Public()` there only
 *    exempts the route from the USER auth chain; the route is NOT publicly reachable, and a
 *    401 without credentials is the CORRECT, stronger-than-declared outcome. Asserted
 *    positively so a regression that made one of them actually public would fail.
 */
const casesA5All = sweptRoutes.filter((r) => r.isPublic);
const casesA5Internal = casesA5All.filter((r) => r.path.startsWith('/api/v1/internal/'));
const casesA5 = casesA5All.filter((r) => !r.path.startsWith('/api/v1/internal/'));

/** Marks a 401 emitted by `UnifiedAuthGuard` rather than by a route handler. */
const GUARD_401_MARKERS = [
  'Authentication required',
  'Missing authentication',
  'Invalid API key',
  'Invalid or expired token',
  'X-Service-Token',
  'Unauthorized access',
];
function isGuardRejection(p: Probe | undefined): boolean {
  if (!p || p.status !== 401) return false;
  return GUARD_401_MARKERS.some((m) => p.body.includes(m)) || p.body === '';
}

function describeFailure(p: Probe | undefined, route: ManifestRoute, credential: CredentialClass, expected: string) {
  const actual = p ? (p.status === -1 ? `transport error (${p.error})` : String(p.status)) : 'NOT PROBED';
  return `  - ${routeLabel(route)} | credential=${credential} | expected ${expected} | actual ${actual}`;
}

function assertAll(
  label: string,
  cases: ManifestRoute[],
  credential: CredentialClass,
  predicate: (status: number) => boolean,
  expected: string,
): void {
  const failures: string[] = [];
  for (const route of cases) {
    const p = results.get(probeKey(route, credential));
    if (!p || !predicate(p.status)) failures.push(describeFailure(p, route, credential, expected));
  }
  expect(failures, `${label}: ${failures.length}/${cases.length} routes did not conform.\n${failures.join('\n')}`).toEqual([]);
}

// ---------------------------------------------------------------------------

test.describe(' route authorization conformance matrix', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    test.setTimeout(600_000);

    // --- verify credentials against the live API BEFORE the sweep -----------
    const login = await request.post('/api/v1/auth/login', {
      data: { username: SEEDED_USERS.superAdmin.username, password: SEEDED_USERS.superAdmin.password },
    });
    expect(login.status(), 'super-admin login must succeed').toBeLessThan(300);
    expect((await login.json()).token, 'login must return a JWT').toBeTruthy();

    apiKey = SEEDED_API_KEY;
    // POSITIVE capability check: the key must actually reach a route it IS permitted on.
    // Without this, an expired/invalid key would still 401 everywhere and could make the
    // A2 sweep look meaningful when it is measuring nothing.
    const keyCheck = await request.get('/api/v1/consultations', { headers: { 'X-API-Key': apiKey } });
    expect(
      keyCheck.status(),
      `seeded API key must be VALID and permitted on /consultations (a 401/403 here would make ` +
        `every A2 assertion vacuous). Got ${keyCheck.status()}`,
    ).toBeLessThan(300);

    const svc = await request.post('/api/v1/auth/service-token', {
      data: { clientId: SERVICE_ACCOUNT_CLIENT_ID, clientSecret: SERVICE_ACCOUNT_CLIENT_SECRET },
    });
    expect(svc.status(), 'service-account token exchange must succeed').toBeLessThan(300);
    const svcBody = await svc.json();
    serviceAccountToken = svcBody.accessToken;
    expect(serviceAccountToken, 'service-token exchange must return an accessToken').toBeTruthy();
    expect(
      Array.isArray(svcBody.scopes) && svcBody.scopes.length > 0,
      'service account must carry scopes (an unscoped SA would make A4 vacuous)',
    ).toBe(true);

    // POSITIVE capability check for the service account, same reasoning as the API key.
    const svcCheck = await request.get('/api/v1/admin/users', {
      headers: { 'X-Service-Account-Token': serviceAccountToken },
    });
    expect(
      svcCheck.status(),
      `service-account token must be VALID and permitted on admin/users (a blanket 401/403 would ` + `make A3/A4 vacuous). Got ${svcCheck.status()}`,
    ).toBeLessThan(300);

    // --- one sweep for the whole file --------------------------------------
    const jobs: Array<[ManifestRoute, CredentialClass]> = [];
    const seen = new Set<string>();
    const enqueue = (routes: ManifestRoute[], credential: CredentialClass) => {
      for (const r of routes) {
        const k = probeKey(r, credential);
        if (seen.has(k)) continue;
        seen.add(k);
        jobs.push([r, credential]);
      }
    };
    enqueue([...casesA1, ...casesA5All], 'none');
    enqueue(casesA2, 'apiKey');
    enqueue([...casesA3, ...casesA4], 'serviceAccount');

    const started = Date.now();
    await runAll(jobs);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    const inert = new Set(casesA2Inert.map((r) => `${r.method} ${r.path}`));
    const unexpected2xx = [...results.values()].filter(
      (p) =>
        p.status >= 200 &&
        p.status < 300 &&
        // A public route answering 200 without credentials is the CORRECT outcome, and the
        // six inert @ForbidApiKey declarations below cannot return 403 by construction.
        !(p.credential === 'none' && p.route.isPublic) &&
        !inert.has(`${p.route.method} ${p.route.path}`),
    );
    const transportErrors = [...results.values()].filter((p) => p.status === -1);

    /* eslint-disable no-console -- the sweep summary is the deliverable of this suite */
    console.log(
      [
        '',
        '===  route authz conformance sweep ===',
        `manifest routes            : ${allRoutes.length}`,
        `skipped                    : ${skips.size}` + (skips.size ? ` (${[...new Set(skips.values())].join(', ')})` : ' (none)'),
        `swept routes               : ${sweptRoutes.length}`,
        `requests issued            : ${jobs.length} (concurrency ${CONCURRENCY}, ${elapsed}s)`,
        '--- generated cases ---',
        `A1 no-credential -> 401    : ${casesA1.length}`,
        `A2 api-key forbidden -> 403: ${casesA2.length} (+${casesA2Inert.length} inert on @Public routes)`,
        `A3 svc forbidden -> 403    : ${casesA3.length}`,
        `A4 svc undeclared -> 403   : ${casesA4.length}`,
        `A5 public -> reachable     : ${casesA5.length}`,
        `A5b public+svc-token -> 401: ${casesA5Internal.length}`,
        '--- anomalies ---',
        `2xx responses (findings)   : ${unexpected2xx.length}`,
        `transport errors/timeouts  : ${transportErrors.length}`,
        '',
      ].join('\n'),
    );
    if (unexpected2xx.length) {
      console.log('2xx responses to a credential class the manifest forbids:');
      for (const p of unexpected2xx) console.log(`  ${p.credential} ${routeLabel(p.route)} -> ${p.status}`);
    }
    if (transportErrors.length) {
      console.log('transport errors / timeouts:');
      for (const p of transportErrors) console.log(`  ${p.credential} ${routeLabel(p.route)} -> ${p.error}`);
    }
    /* eslint-enable no-console -- end of summary block */
  });

  test('A1 — every non-public route rejects an unauthenticated request with 401', () => {
    assertAll('A1 NO-CREDENTIAL', casesA1, 'none', (s) => s === 401, '401');
  });

  test('A2 — every enforceable @ForbidApiKey route returns 403 for a valid API key', () => {
    assertAll('A2 API-KEY FORBIDDEN', casesA2, 'apiKey', (s) => s === 403, '403');
  });

  test('A2b — @ForbidApiKey on a @Public route is inert, and the inventory is frozen', () => {
    // Documented carve-out: the guard never runs on a public route, so 403 is unreachable.
    expect(
      casesA2Inert.map((r) => `${r.method} ${r.path}`).sort(),
      'a new @Public route declaring @ForbidApiKey appeared — the decorator there is inert ' +
        'and must either be removed or the route made non-public',
    ).toEqual([...INERT_FORBID_API_KEY].sort());

    // They are inert, not dangerous: none of them grants a privileged 2xx to an API key.
    const escalations = casesA2Inert
      .filter((r) => {
        const p = results.get(probeKey(r, 'apiKey'));
        return p !== undefined && p.status >= 200 && p.status < 300 && !/\/health/.test(r.path);
      })
      .map((r) => describeFailure(results.get(probeKey(r, 'apiKey')), r, 'apiKey', 'no privileged 2xx'));
    expect(escalations, `A2b INERT @ForbidApiKey granted a privileged 2xx:\n${escalations.join('\n')}`).toEqual([]);
  });

  test('A3 — every forbidServiceAccount route returns 403 for a valid service-account token', () => {
    assertAll('A3 SERVICE-ACCOUNT FORBIDDEN', casesA3, 'serviceAccount', (s) => s === 403, '403');
  });

  test('A4 — routes with no declared service scopes deny service accounts (403)', () => {
    assertAll('A4 SERVICE-ACCOUNT UNDECLARED', casesA4, 'serviceAccount', (s) => s === 403, '403');
  });

  test('A5 — every genuinely public route is REACHED without credentials (no guard 401)', () => {
    const failures = casesA5
      .filter((r) => {
        const p = results.get(probeKey(r, 'none'));
        return !p || p.status === -1 || isGuardRejection(p);
      })
      .map((r) => describeFailure(results.get(probeKey(r, 'none')), r, 'none', 'no guard rejection'));
    expect(
      failures,
      `A5 PUBLIC: ${failures.length}/${casesA5.length} routes were rejected by the auth guard ` + `despite @Public().\n${failures.join('\n')}`,
    ).toEqual([]);
  });

  test('A5b — @Public() /internal/* routes are service-token-gated, not publicly reachable', () => {
    assertAll('A5b PUBLIC-BUT-SERVICE-TOKEN-GATED', casesA5Internal, 'none', (s) => s === 401, '401');
    // Inventory derived from `apps/api/route-manifest.json`:
    //   routes where isPublic === true && path startsWith '/api/v1/internal/'
    //   = 26 HarnessInternalController + 2 ServiceReleaseInternalController
    //   + 1 ConsentInternalController + 1 EffectiveConfigController = 30.
    // (Harness grew from 20: `live-summary` + `live-assist` in,
    // `provider-credential` in, and `endpoint/feedback` +
    // `endpoint/finalize` + `endpoint/session` in .)
    //
    // Every one of those controllers also carries `@ApiExcludeController()`. That flag is a
    // DOCUMENTATION-visibility signal only, and must never be allowed to shrink this inventory
    // (see `skipReasonFor` in ./helpers/route-manifest.helper.ts). If this number collapses
    // toward 0, suspect the sweep's skip predicate before suspecting the routes.
    expect(casesA5Internal.length, 'inventory of @Public() /internal/* routes').toBe(30);
  });
});
