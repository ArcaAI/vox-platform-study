/**
 * Phase 3 scaffold smoke: session gate, login round-trip, logout. Covers only
 * what exists today (no feature screens — design gate). Specs needing the
 * gateway additionally skip when it is down.
 */

import { expect, test } from '@playwright/test';
import { ADMIN_CREDENTIALS, API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async () => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
});

async function signIn(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/login');
    await page.getByLabel('Username').fill(ADMIN_CREDENTIALS.username);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_CREDENTIALS.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/dashboard');
}

test.describe('session gate (proxy.ts)', () => {
    test('unauthenticated page requests redirect to /login with the origin preserved', async ({ page }) => {
        await page.goto('/dashboard');
        await expect(page).toHaveURL(/\/login\?from=%2Fdashboard/);
        await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    });

    test('unauthenticated API requests get 401 JSON, not a redirect', async ({ request }) => {
        const response = await request.get('/api/hope/admin/tenants');
        expect(response.status()).toBe(401);
        expect(await response.json()).toEqual({ message: 'Unauthorized' });
    });
});

test.describe('login page', () => {
    test('renders the sign-in form', async ({ page }) => {
        await page.goto('/login');
        await expect(page.getByText('HOPE Admin Console')).toBeVisible();
        await expect(page.getByLabel('Username')).toBeVisible();
        await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
        await expect(page.getByLabel(/tenant key/i)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    });

    test('a failed login surfaces the gateway error and stays on /login', async ({ page }) => {
        test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);

        await page.goto('/login');
        await page.getByLabel('Username').fill(ADMIN_CREDENTIALS.username);
        await page.getByLabel('Password', { exact: true }).fill('definitely-wrong-password');
        await page.getByRole('button', { name: 'Sign in' }).click();

        await expect(page.getByRole('alert')).toBeVisible();
        await expect(page).toHaveURL(/\/login/);
    });
});

test.describe('authenticated round-trip (seeded global admin)', () => {
    test.beforeEach(async () => {
        test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    });

    test('successful login lands on the dashboard', async ({ page }) => {
        await signIn(page);
        // Designed dashboard (frame 10): shell nav + the screen's h1.
        await expect(page.getByRole('link', { name: 'HOPE Admin' })).toBeVisible();
        await expect(page.getByRole('heading', { level: 1, name: 'Platform Dashboard' })).toBeVisible();
    });

    test('logout drops the session and the gate re-engages', async ({ page }) => {
        await signIn(page);

        await page.getByRole('button', { name: 'Account menu' }).click();
        await page.getByRole('menuitem', { name: 'Log out' }).click();
        await page.waitForURL('**/login');

        // The session cookie is gone: a protected page redirects again.
        await page.goto('/dashboard');
        await expect(page).toHaveURL(/\/login/);
    });
});
