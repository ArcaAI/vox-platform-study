/**
 * TASK-400 — Password security hardening · frontend flows.
 *
 * Drives the REAL UI (dev server :5174 → API :8868 via the Vite proxy) across
 * the three viewport projects:
 *
 *   1. Login page carries a "Forgot password?" link → public request page.
 *   2. /forgot-password submits and lands on the SAME generic success state
 *      whether or not the email exists (anti-enumeration mirror of the API's
 *      always-202 contract). Nothing is written for an unknown email.
 *   3. /reset-password surfaces the complexity checklist INLINE (unmet rules
 *      only) and gates the submit button until policy + confirm match.
 *   4. Full completion: a throwaway user is created via the (super-admin)
 *      API, a reset link is minted through the ADMIN flow (BC — the admin
 *      response still carries the token), and the browser finishes the reset
 *      through the real page. The new password is proven by a real login.
 *
 * RUN (stack already up; never rebuilds/restarts the API):
 *   SKIP_DB_PRECHECK=true pnpm --filter @arcaai/admin exec playwright test task-400
 *
 * @see docs/implementation/TASK-400-Password-Security-Hardening/README.md
 */
import type { APIRequestContext } from '@playwright/test';
import { test, expect, PERSONAS } from './fixtures/auth';

const UNIQUE = Date.now();

/** Strong password compliant with the DEFAULT policy (12+, U/l/d/special). */
const STRONG_PW = `T400!fe-${UNIQUE}aB`;

/**
 * Creation-time password for the throwaway user. TASK-402 enforces the strict
 * complexity policy on POST /admin/users, so the old `'x'` placeholder is now
 * rejected with 400 — the fixture password must itself be compliant. Distinct
 * from STRONG_PW so the reset flow still proves a REAL password change.
 */
const INITIAL_PW = `T400init!${UNIQUE}aB`;

/** Authenticate the seeded super admin against the API (via the Vite proxy). */
async function apiLogin(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', {
    data: { username: PERSONAS.superAdmin.username, password: PERSONAS.superAdmin.password, tenantKey: '__GLOBAL__' },
  });
  expect(res.status(), 'super_admin API login for spec setup').toBe(200);
  return ((await res.json()) as { token: string }).token;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('TASK-400 FE 1 — login page entry point', () => {
  test('login page links to the public forgot-password page', async ({ page }) => {
    await page.goto('/login');
    const link = page.getByRole('link', { name: 'Forgot password?' });
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL('**/forgot-password');
    await expect(page.getByRole('heading', { name: 'HOPE Admin Console' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
  });
});

test.describe('TASK-400 FE 2 — forgot-password request page (anti-enumeration)', () => {
  test('unknown email still lands on the generic success state', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(`t400.fe.unknown.${UNIQUE}@example.com`);
    await page.getByRole('button', { name: 'Send reset link' }).click();

    const status = page.getByRole('status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('If an account exists for that email');
    // The page must NOT leak a token or a completion link.
    await expect(page.locator('body')).not.toContainText('token=');

    await page.getByRole('link', { name: 'Back to sign in' }).click();
    await page.waitForURL('**/login');
  });
});

test.describe('TASK-400 FE 3 — completion page inline complexity', () => {
  test('checklist lists ONLY the unmet rules and gates the submit button', async ({ page }) => {
    // Any token value renders the form — no submit happens in this test.
    await page.goto('/reset-password?token=fe-inline-check');
    const pw = page.locator('#new-password');
    const confirm = page.locator('#confirm-password');
    const submit = page.getByRole('button', { name: 'Reset password' });
    const rules = page.getByTestId('password-rules');

    // Weak: short, no uppercase, no digit, no special → those four rules show.
    await pw.fill('weakpass');
    await expect(rules).toBeVisible();
    await expect(rules).toContainText('At least 12 characters');
    await expect(rules).toContainText('One uppercase letter (A-Z)');
    await expect(rules).toContainText('One number (0-9)');
    await expect(rules).toContainText('One special character (e.g. !@#$%)');
    await expect(rules).not.toContainText('One lowercase letter (a-z)');
    await expect(submit).toBeDisabled();

    // Progressive repair: each fix removes its rule from the checklist.
    await pw.fill('Weakpass1!');
    await expect(rules).toContainText('At least 12 characters');
    await expect(rules).not.toContainText('One uppercase letter (A-Z)');

    // Compliant password → checklist disappears; confirm mismatch still gates.
    await pw.fill(STRONG_PW);
    await expect(rules).not.toBeVisible();
    await confirm.fill('Different1!x');
    await expect(page.getByText('Passwords don’t match.')).toBeVisible();
    await expect(submit).toBeDisabled();

    // Match → submit unlocks.
    await confirm.fill(STRONG_PW);
    await expect(submit).toBeEnabled();
  });
});

test.describe('TASK-400 FE 4 — full reset completion (real token)', () => {
  test('a minted reset link completes in the browser and the new password logs in', async ({ page, request }, testInfo) => {
    const token = await apiLogin(request);
    const username = `t400fe_${testInfo.project.name}_${UNIQUE}`;

    // Throwaway user with full __GLOBAL__ membership (role + department)
    // so the post-reset proof can be a REAL login returning 200.
    const create = await request.post('/api/v1/admin/users', {
      headers: bearer(token),
      data: { username, password: INITIAL_PW },
    });
    expect(create.status(), 'create throwaway user').toBeLessThan(300);
    const userId = ((await create.json()) as { id: string }).id;

    const asArray = <T>(raw: unknown): T[] => (Array.isArray(raw) ? (raw as T[]) : ((raw as { data?: T[] })?.data ?? []));
    const roles = asArray<{ id: string; name: string }>(await (await request.get('/api/v1/admin/rbac/roles', { headers: bearer(token) })).json());
    const role = roles.find((r) => r.name === 'DOCTOR') ?? roles[0];
    expect(role, 'a seeded role exists').toBeTruthy();
    await request.post(`/api/v1/admin/users/${userId}/roles`, { headers: bearer(token), data: { roleId: role.id } });
    const depts = asArray<{ id: string }>(await (await request.get('/api/v1/admin/departments', { headers: bearer(token) })).json());
    expect(depts.length, 'a seeded department exists').toBeGreaterThan(0);
    await request.post(`/api/v1/admin/users/${userId}/departments`, {
      headers: bearer(token),
      data: { departmentId: depts[0].id, isPrimary: true },
    });

    try {
      // Mint the completion link through the ADMIN flow (TASK-388 BC: the
      // admin response still returns the token for out-of-band delivery).
      const mint = await request.post(`/api/v1/admin/users/${userId}/reset-password`, {
        headers: bearer(token),
        data: { mode: 'link' },
      });
      expect([200, 201], 'mint reset link').toContain(mint.status());
      const { resetPath } = (await mint.json()) as { resetPath: string };
      expect(resetPath).toContain('/reset-password?token=');

      // Complete in the real browser.
      await page.goto(resetPath);
      await page.locator('#new-password').fill(STRONG_PW);
      await page.locator('#confirm-password').fill(STRONG_PW);
      await page.getByRole('button', { name: 'Reset password' }).click();
      await expect(page.getByText('Your password has been reset.')).toBeVisible();

      // Proof 1 — the new password is live: a real login returns 200.
      const relog = await request.post('/api/v1/auth/login', {
        data: { username, password: STRONG_PW, tenantKey: '__GLOBAL__' },
      });
      expect(relog.status(), 'new password authenticates').toBe(200);

      // Proof 2 — the consumed token is single-use: a replay is rejected.
      const replay = await request.post('/api/v1/users/password-reset/complete', {
        data: { token: new URL(`http://x${resetPath}`).searchParams.get('token'), newPassword: `${STRONG_PW}zZ9!` },
      });
      expect(replay.status(), 'token is single-use').toBe(400);
    } finally {
      await request.delete(`/api/v1/admin/users/${userId}`, { headers: bearer(token) }).catch(() => undefined);
    }
  });
});
