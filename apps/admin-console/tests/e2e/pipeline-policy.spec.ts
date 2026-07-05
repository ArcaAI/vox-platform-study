/**
 * Frame 39 — Realtime Pipeline Policy against a RUNNING stack (rule 12
 * gate 3): screen smoke, matrix/editor interaction plus axe scans in both
 * themes. Skips with actionable messages when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    // Pipeline policy is tenant-scoped: elevated sessions see the
    // "Select a working tenant" gate until one is chosen.
    await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Realtime Pipeline Policy' })).toBeVisible();
    // The screen settles into the cascade matrix, the no-overrides empty
    // state or the block error state. The alert must be narrowed to the
    // error-block copy — the shell always mounts empty role=alert regions
    // (route announcer, toaster), which would satisfy a bare getByRole and
    // let the helper resolve before the data actually settles.
    const matrix = page.getByRole('table', { name: 'Pipeline policy scope rows' });
    const emptyState = page.getByText('No scope overrides yet');
    const errorState = page.getByRole('alert').filter({ hasText: /Couldn.t load/ });
    await expect(matrix.first().or(emptyState.first()).or(errorState.first())).toBeVisible();
}

test.describe('realtime pipeline policy (frame 39)', () => {
    test('shows the header, the filter strip and the cascade panels', async ({ page }) => {
        await page.goto('/harness/pipeline-policy');
        await waitForSettled(page);
        await expect(page.getByLabel('Scope:')).toBeVisible();
        await expect(page.getByLabel('Key:')).toBeVisible();
        await expect(page.getByLabel('Show effective:')).toBeVisible();
    });

    test('a matrix row click opens the scope-row editor panel', async ({ page }) => {
        await page.goto('/harness/pipeline-policy');
        await waitForSettled(page);
        // Without seeded overrides the screen may open on the empty state —
        // its CTA opens the same TENANT editor. Race both entry points with an
        // auto-waiting assertion (isVisible alone doesn't wait, so checking it
        // straight after settle can take the wrong branch mid-render).
        const tenantRow = page.getByRole('table', { name: 'Pipeline policy scope rows' }).locator('tbody tr', { hasText: 'tenant' }).first();
        const addScopeRow = page.getByRole('button', { name: 'Add scope row' });
        await expect(tenantRow.or(addScopeRow)).toBeVisible();
        if (await tenantRow.isVisible()) {
            await tenantRow.click();
        } else {
            await addScopeRow.click();
        }
        await expect(page.getByRole('radiogroup', { name: 'Auto-summary' })).toBeVisible();
        await expect(page.getByRole('button', { name: /Save row · PUT/ })).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/harness/pipeline-policy');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/harness/pipeline-policy');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});
