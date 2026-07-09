/**
 * TASK-445 — secret rotation flow (frame 24, Settings & secrets): the drawer's
 * Rotate affordance drives the REAL endpoint (`POST /admin/settings/:id/rotate`
 * — step-up password + If-Match OCC), replacing the TASK-439 guided-replace.
 * Covers the happy path (success toast, version bump, plaintext never shown)
 * and the step-up rejection (in-dialog error, dialog stays open). Requires a
 * running stack; the fixture secret is created and cleaned up via the BFF.
 */

import { expect, test, type Page } from '@playwright/test';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { ADMIN_CREDENTIALS, API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    // The fixture secret is created through the BFF, which scopes writes to the
    // elevated session's working tenant — select one first (GlobalSetting rows
    // require a tenant; the platform default is fine for a throwaway fixture).
    await selectWorkingTenant(page);
});

/**
 * Creates a convention-named secret setting through the BFF (in-page fetch so
 * the session cookie applies). Returns null when the stack refuses creation —
 * callers skip rather than fail (parity with settings.spec.ts's defensive skips).
 */
async function createFixtureSecret(page: Page): Promise<{ id: string; key: string } | null> {
    const key = `secrets.e2e-rotate-${Date.now()}`;
    return page.evaluate(async (settingKey) => {
        const response = await fetch('/api/hope/admin/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'E2E rotate fixture',
                key: settingKey,
                value: 'initial-secret-value',
                dataType: 'String',
                namespace: 'secrets',
                description: 'Temporary fixture for the TASK-445 rotate e2e — safe to delete.',
            }),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { id: string };
        return { id: body.id, key: settingKey };
    }, key);
}

async function deleteFixtureSecret(page: Page, id: string): Promise<void> {
    await page.evaluate(async (settingId) => {
        await fetch(`/api/hope/admin/settings/${settingId}`, { method: 'DELETE' });
    }, id);
}

/** Opens the fixture's detail drawer via the URL-shareable grid search. */
async function openSecretDrawer(page: Page, key: string): Promise<void> {
    await page.goto(`/settings?search=${encodeURIComponent(key)}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Settings & secrets' })).toBeVisible();
    const row = page.getByRole('grid', { name: 'Settings' }).getByRole('row', { name: new RegExp(key) });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole('dialog').getByRole('tab', { name: 'Value' })).toBeVisible();
}

test.describe('secret rotation (TASK-445)', () => {
    test('rotates a secret through the endpoint: step-up dialog, success toast, version bump, no plaintext', async ({ page }) => {
        const fixture = await createFixtureSecret(page);
        test.skip(!fixture, 'stack refused the fixture secret create');
        const { id, key } = fixture!;

        try {
            await openSecretDrawer(page, key);
            const drawer = page.getByRole('dialog').first();
            // Secret posture: masked value, v1.
            await expect(drawer.getByText('v1')).toBeVisible();
            await expect(drawer.getByText('Secret value hidden')).toBeVisible();

            // exact: the fixture key contains "rotate", so a loose name match
            // also hits the "Reveal <key>" button — pin to the Rotate trigger.
            await drawer.getByRole('button', { name: 'Rotate', exact: true }).click();
            const rotateDialog = page.getByRole('dialog', { name: 'Rotate secret' });
            await expect(rotateDialog).toBeVisible();
            // Armed only with both inputs.
            await expect(rotateDialog.getByRole('button', { name: 'Rotate secret' })).toBeDisabled();
            await rotateDialog.getByLabel('New secret value').fill('rotated-secret-value');
            await rotateDialog.getByLabel('Password').fill(ADMIN_CREDENTIALS.password);
            await rotateDialog.getByRole('button', { name: 'Rotate secret' }).click();

            // Success: toast, dialog closes, drawer reflects the bumped version.
            await expect(page.getByText(`${key} rotated`)).toBeVisible();
            await expect(rotateDialog).not.toBeVisible();
            await expect(drawer.getByText('v2')).toBeVisible();
            // The rotated plaintext never renders anywhere.
            await expect(page.getByText('rotated-secret-value')).toHaveCount(0);
        } finally {
            await deleteFixtureSecret(page, id);
        }
    });

    test('rejects a wrong step-up password in-dialog and keeps the dialog open', async ({ page }) => {
        const fixture = await createFixtureSecret(page);
        test.skip(!fixture, 'stack refused the fixture secret create');
        const { id, key } = fixture!;

        try {
            await openSecretDrawer(page, key);
            await page.getByRole('dialog').first().getByRole('button', { name: 'Rotate', exact: true }).click();
            const rotateDialog = page.getByRole('dialog', { name: 'Rotate secret' });
            await rotateDialog.getByLabel('New secret value').fill('rotated-secret-value');
            await rotateDialog.getByLabel('Password').fill('definitely-not-the-password');
            await rotateDialog.getByRole('button', { name: 'Rotate secret' }).click();

            // Break-glass style: the failure stays IN the dialog.
            await expect(rotateDialog.getByRole('alert')).toContainText(/password/i);
            await expect(rotateDialog).toBeVisible();

            // The secret is untouched — still v1 after cancelling out.
            await rotateDialog.getByRole('button', { name: 'Cancel' }).click();
            await expect(page.getByRole('dialog').first().getByText('v1')).toBeVisible();
        } finally {
            await deleteFixtureSecret(page, id);
        }
    });
});
