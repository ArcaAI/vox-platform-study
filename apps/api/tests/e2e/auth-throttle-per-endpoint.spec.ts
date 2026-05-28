/**
 * TASK-308 AC-6 — per-endpoint throttle granularity on `AuthController`.
 *
 * Pins AC-5's contract at the HTTP layer:
 *
 *   - `/auth/login`   is throttled at 5/min  → 6+ rapid attempts produce
 *                                              at least one 429 within the
 *                                              first six.
 *   - `/auth/refresh` is throttled at 60/min → 11 rapid attempts produce
 *                                              zero 429s (the previous
 *                                              class-wide 10/min would
 *                                              have tripped at the 11th).
 *   - `/auth/me`      rides the app-wide default (100/min) → 8 rapid
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
import {
    DEFAULT_TENANT_KEY,
    SEEDED_USERS,
    loginUser,
} from '../../../../tests/helpers';

const BOGUS_USERNAME_PREFIX = 'task-308-throttle-bogus';
const BOGUS_REFRESH_TOKEN = 'task-308-throttle-not-a-real-refresh-token';

/** Collect statuses from N sequential calls to a Playwright request. */
async function probeStatuses(
    n: number,
    invoke: (i: number) => Promise<APIResponse>,
): Promise<number[]> {
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

test.describe('TASK-308 AC-6 — Auth throttle granularity', () => {
    // The doctor login is the FIRST `/auth/login` call this spec makes —
    // it must succeed (and get its token) BEFORE the rapid-login probe
    // consumes the 5/min budget. Running it in `beforeAll` keeps the
    // /me test independent of the order/state of the login throttle test.
    let doctorToken: string;

    test.beforeAll(async ({ request }) => {
        const login = await loginUser(
            request,
            SEEDED_USERS.doctor.username,
            SEEDED_USERS.doctor.password,
            DEFAULT_TENANT_KEY,
        );
        expect(login, 'doctor login failed (precondition for /me probe)').toBeTruthy();
        doctorToken = login!.token;
    });

    // Tests run in declaration order under `mode: 'serial'`. /me first
    // because it doesn't perturb the login counter; refresh next because
    // it lives on its own counter; login last because it deliberately
    // burns through the 5/min budget.

    test('GET /auth/me rides the default throttler — 8 rapid authenticated reads produce ZERO 429s', async ({
        request,
    }) => {
        const statuses = await probeStatuses(8, () =>
            request.get('/api/v1/auth/me', {
                headers: { Authorization: `Bearer ${doctorToken}` },
            }),
        );

        const throttled = statuses.filter((s) => s === 429).length;
        expect(
            throttled,
            `/auth/me should not 429 at 8/min under default throttler, got ${JSON.stringify(statuses)}`,
        ).toBe(0);
        // Sanity: every /me read should succeed for a valid token.
        const successes = statuses.filter((s) => s === 200).length;
        expect(successes).toBe(8);
    });

    test('POST /auth/refresh allows >10/min — 11 rapid attempts produce ZERO 429s', async ({
        request,
    }) => {
        const statuses = await probeStatuses(11, () =>
            request.post('/api/v1/auth/refresh', {
                data: { refreshToken: BOGUS_REFRESH_TOKEN },
            }),
        );

        const throttled = statuses.filter((s) => s === 429).length;
        expect(
            throttled,
            `expected 0 of the 11 rapid refresh attempts to 429, got statuses ${JSON.stringify(statuses)}`,
        ).toBe(0);
        // Every attempt SHOULD fail at handler validation (bogus token) —
        // catching a stray 200 here would mean refresh isn't validating.
        const successes = statuses.filter((s) => s === 200).length;
        expect(successes, 'no bogus refresh attempt should produce 200').toBe(0);
    });

    test('POST /auth/login enforces 5/min — at least one 429 within the first 6 rapid attempts', async ({
        request,
    }) => {
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
        expect(
            throttled,
            `expected ≥1 of the 6 rapid login attempts to 429, got statuses ${JSON.stringify(statuses)}`,
        ).toBeGreaterThanOrEqual(1);
    });
});
