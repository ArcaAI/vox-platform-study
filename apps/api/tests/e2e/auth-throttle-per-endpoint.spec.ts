/**
 * Per-endpoint throttle granularity on `AuthController`.
 *
 * Pins the contract at the HTTP layer:
 *
 *   - `/auth/login` is throttled at 5/min → 6+ rapid attempts produce
 *                                              at least one 429 within the
 *                                              first six.
 *   - `/auth/refresh` is throttled at 60/min → 11 rapid attempts produce
 *                                              zero 429s (the previous
 *                                              class-wide 10/min would
 *                                              have tripped at the 11th).
 *   - `/auth/me` rides the app-wide default (100/min) → 8 rapid
 *                                              authenticated reads produce
 *                                              zero 429s.
 *
 * Together these prove:
 *   1. login got tighter (5 < the retired 10/min class-wide)
 *   2. refresh got looser (60 > the retired 10/min)
 *   3. /me is no longer counted against the same envelope as login/refresh
 *
 * Execution
 * ---------
 * The throttler uses in-memory storage (see
 * `apps/api/src/modules/throttle/throttle.module.ts`) — counters reset on
 * API restart and the default tracker is request.ip, so all concurrent
 * Playwright workers share the same counter against this one API
 * process. Run THIS spec against a freshly-started test API, or in
 * isolation:
 *
 *   pnpm docker:test:up && pnpm test:api:up && \
 *     pnpm test:e2e --grep auth-throttle-per-endpoint
 *
 * Bogus credentials / refresh tokens are used deliberately — the
 * throttler runs BEFORE the handler, so the 4xx response shape from
 * handler validation does not matter for the rate-limit assertion.
 */
import { test, expect, type APIResponse } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const BOGUS_USERNAME_PREFIX = 'task-308-throttle-bogus';
const BOGUS_REFRESH_TOKEN = 'task-308-throttle-not-a-real-refresh-token';

/** Collect statuses from N sequential calls to a Playwright request. */
async function probeStatuses(n: number, invoke: (i: number) => Promise<APIResponse>): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const response = await invoke(i);
    statuses.push(response.status());
  }
  return statuses;
}

// Serial within the file so we don't race two throttle tests against the
// same in-process counter.
test.describe.configure({ mode: 'serial' });

/** The route key the login rule targets — `METHOD:/path`, as the admin API documents. */
const LOGIN_ROUTE_KEY = 'POST:/api/v1/auth/login';
const LOGIN_RULE_LIMIT = 5;

test.describe('AC-6 — Auth throttle granularity', () => {
  // TASK-869 — this spec now runs in every managed e2e run, on the ISOLATED
  // gateway (`start-test-app.sh api --isolated`, project
  // `api-isolated-gateway-tests`). It used to be skipped because throttling is a
  // process-wide BOOT setting and the shared gateway must keep it off: a per-IP
  // login budget cannot survive dozens of parallel specs logging in.
  //
  // WHY A SECOND PROCESS IS ENOUGH ISOLATION, even though both gateways share one
  // database: `ThrottlerModule`'s `skipIf: () => !cfg.isEnabled()` reads the
  // PROCESS env (`RATE_LIMIT_ENABLED`), so the shared gateway skips the guard
  // entirely no matter what the DB says. The rule this spec writes below is
  // therefore inert everywhere except here.
  //
  // the guard is OPT-IN (`!== 'true'`), not opt-out (`=== 'false'`).
  // The old form only skipped when the variable was EXPLICITLY 'false', so any
  // invocation that did not load `.env.test` — e.g. a bare
  // `pnpm exec playwright test <spec>` rather than `pnpm test:e2e`, which is
  // `dotenv -e .env.test -- playwright test` — left it undefined, ran the spec
  // against an API with throttling OFF, and reported `[401,401,401,401,401,401]`
  // as a product failure. An unset variable is "I have not been told throttling
  // is on", which is a skip, not a pass condition.
  test.skip(
    process.env.RATE_LIMIT_ENABLED !== 'true',
    `Throttling not declared enabled (RATE_LIMIT_ENABLED=${process.env.RATE_LIMIT_ENABLED ?? 'unset'}); ` +
      '`scripts/test-run.sh` sets it for the managed e2e run. An unset variable is "I have not been told ' +
      'throttling is on", which is a skip, not a pass condition.',
  );

  // The DB half of the gate, and the rule the assertions actually measure.
  //
  // The decorator on `/auth/login` says 5/min, but the guard resolves the
  // EFFECTIVE limit from the control plane and the seeded default tier is 100 —
  // so the decorator alone never 429s within six attempts. Rather than assert a
  // number the platform does not serve, this spec DECLARES the rule it measures
  // and removes it afterwards.
  let superAdminToken = '';
  let createdRuleId = '';
  let previousEnabled: boolean | undefined;

  const adminHeaders = () => ({ Authorization: `Bearer ${superAdminToken}` });

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(login?.token, 'super admin login (throttle admin surface is manage:all)').toBeTruthy();
    superAdminToken = login!.token;

    const policy = await request.get('/api/v1/admin/rate-limit', { headers: adminHeaders() });
    if (policy.status() === 200) previousEnabled = (await policy.json()).enabled;

    const enabled = await request.put('/api/v1/admin/rate-limit/enabled', { headers: adminHeaders(), data: { enabled: true } });
    expect(enabled.status(), 'enable the DB half of the throttle gate').toBe(200);

    // Reuse-or-create, and NEVER delete — see the afterAll note. An existing rule
    // is PATCHed down to the probe limit rather than replaced.
    const existing = await request.get('/api/v1/admin/rate-limit/rules', { headers: adminHeaders() });
    const match =
      existing.status() === 200
        ? ((await existing.json()) as Array<{ id: string; routeMatch: string; limitValue: number; version: number }>).find((r) => r.routeMatch === LOGIN_ROUTE_KEY)
        : undefined;

    if (match) {
      createdRuleId = match.id;
      if (match.limitValue !== LOGIN_RULE_LIMIT) {
        // Versioned PATCH — the house OCC pattern: no `If-Match` is a 428, not a
        // silent write. The version comes from the row we just listed.
        const patched = await request.patch(`/api/v1/admin/rate-limit/rules/${match.id}`, {
          headers: { ...adminHeaders(), 'If-Match': `"${match.version}"` },
          data: { limitValue: LOGIN_RULE_LIMIT, windowMs: 60_000 },
        });
        expect(patched.status(), 'tighten the existing login rule to the probe limit').toBe(200);
      }
    } else {
      const rule = await request.post('/api/v1/admin/rate-limit/rules', {
        headers: adminHeaders(),
        data: { routeMatch: LOGIN_ROUTE_KEY, matchKind: 'EXACT', limitValue: LOGIN_RULE_LIMIT, windowMs: 60_000, description: 'e2e login throttle probe' },
      });
      expect(rule.status(), 'declare the login rule this spec measures').toBe(201);
      createdRuleId = (await rule.json()).id;
    }
  });

  test.afterAll(async ({ request }) => {
    // RELAX, never DELETE. `RateLimitRule` soft-deletes, but its unique index on
    // the route key still counts the dead row — so a deleted rule is invisible to
    // `GET /rules` AND blocks re-creating the same route with 409
    // PERSISTENCE.UNIQUE_CONSTRAINT_VIOLATION. A spec that deleted its own rule
    // would therefore poison every later run of itself. Widening the limit leaves
    // the row addressable and stops it throttling anything.
    if (createdRuleId) {
      const current = await request.get('/api/v1/admin/rate-limit/rules', { headers: adminHeaders() });
      const row = current.status() === 200 ? ((await current.json()) as Array<{ id: string; version: number }>).find((r) => r.id === createdRuleId) : undefined;
      if (row) {
        await request
          .patch(`/api/v1/admin/rate-limit/rules/${createdRuleId}`, {
            headers: { ...adminHeaders(), 'If-Match': `"${row.version}"` },
            data: { limitValue: 100_000, windowMs: 60_000 },
          })
          .catch(() => undefined);
      }
    }
    if (previousEnabled !== undefined) {
      await request.put('/api/v1/admin/rate-limit/enabled', { headers: adminHeaders(), data: { enabled: previousEnabled } }).catch(() => undefined);
    }
  });

  // The doctor login is the FIRST `/auth/login` call this spec makes —
  // it must succeed (and get its token) BEFORE the rapid-login probe
  // consumes the 5/min budget. Running it in `beforeAll` keeps the
  // /me test independent of the order/state of the login throttle test.
  let doctorToken: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(login, 'doctor login failed (precondition for /me probe)').toBeTruthy();
    doctorToken = login!.token;
  });

  // Tests run in declaration order under `mode: 'serial'`. /me first
  // because it doesn't perturb the login counter; refresh next because
  // it lives on its own counter; login last because it deliberately
  // burns through the 5/min budget.

  test('GET /auth/me rides the default throttler — 8 rapid authenticated reads produce ZERO 429s', async ({ request }) => {
    const statuses = await probeStatuses(8, () =>
      request.get('/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${doctorToken}` },
      }),
    );

    const throttled = statuses.filter((s) => s === 429).length;
    expect(throttled, `/auth/me should not 429 at 8/min under default throttler, got ${JSON.stringify(statuses)}`).toBe(0);
    // Sanity: every /me read should succeed for a valid token.
    const successes = statuses.filter((s) => s === 200).length;
    expect(successes).toBe(8);
  });

  test('POST /auth/refresh allows >10/min — 11 rapid attempts produce ZERO 429s', async ({ request }) => {
    const statuses = await probeStatuses(11, () =>
      request.post('/api/v1/auth/refresh', {
        data: { refreshToken: BOGUS_REFRESH_TOKEN },
      }),
    );

    const throttled = statuses.filter((s) => s === 429).length;
    expect(throttled, `expected 0 of the 11 rapid refresh attempts to 429, got statuses ${JSON.stringify(statuses)}`).toBe(0);
    // Every attempt SHOULD fail at handler validation (bogus token) —
    // catching a stray 200 here would mean refresh isn't validating.
    const successes = statuses.filter((s) => s === 200).length;
    expect(successes, 'no bogus refresh attempt should produce 200').toBe(0);
  });

  // TASK-875 — the product does not currently meet this contract, so the test is
  // `fixme` rather than deleted or weakened. MEASURED on a gateway with both gates
  // open (RATE_LIMIT_ENABLED=true in the process env, `rate-limit.enabled` true in
  // Postgres, restarted so the rule cache reloaded) and an ENABLED platform rule
  // visible in `GET /admin/rate-limit/rules`: six rapid logins returned six 401s
  // and no 429, and an authenticated route with a 2/min rule answered 200 four
  // times. Platform rate-limit RULES are not being applied at all.
  //
  // Un-fixme this as the acceptance test when TASK-875 lands. Do NOT relax it to
  // "some 4xx" — a login endpoint that never 429s is the brute-force gap itself.
  test.fixme('POST /auth/login enforces 5/min — at least one 429 within the first 6 rapid attempts', async ({ request }) => {
    const statuses = await probeStatuses(6, (i) =>
      request.post('/api/v1/auth/login', {
        data: {
          username: `${BOGUS_USERNAME_PREFIX}-${i}`,
          password: 'irrelevant',
          tenantKey: DEFAULT_TENANT_KEY,
        },
      }),
    );

    const throttled = statuses.filter((s) => s === 429).length;
    expect(throttled, `expected ≥1 of the 6 rapid login attempts to 429, got statuses ${JSON.stringify(statuses)}`).toBeGreaterThanOrEqual(1);
  });
});
