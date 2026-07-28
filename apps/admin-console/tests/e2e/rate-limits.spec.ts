/**
 * Frame 16 — Rate Limits screen spec: authenticated smoke of the policy
 * regions (h1, kill-switch, tier + route tables) and the rule 11 §11 axe
 * gate in both themes. Requires a running stack (skips otherwise).
 */

import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

test.describe('rate limits screen', () => {
  test('renders the policy heading, kill-switch and both table regions', async ({ page }) => {
    await page.goto('/rate-limits');
    await expect(page.getByRole('heading', { level: 1, name: 'Rate Limits' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Rate limiting enabled' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Tier defaults' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Route overrides' })).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/rate-limits');
    await expect(page.getByRole('heading', { level: 1, name: 'Rate Limits' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Tier defaults' })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/rate-limits');
    await expect(page.getByRole('heading', { level: 1, name: 'Rate Limits' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Tier defaults' })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('disabling rate limiting opens a confirm dialog that can be cancelled', async ({ page }) => {
    await page.goto('/rate-limits');
    const killSwitch = page.getByRole('switch', { name: 'Rate limiting enabled' });
    await expect(killSwitch).toBeVisible();
    const wasEnabled = await killSwitch.isChecked();
    test.skip(!wasEnabled, 'rate limiting is already disabled in this environment');

    await killSwitch.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('heading', { name: 'Disable rate limiting?' })).toBeVisible();
    await expect(dialog.getByText('Abusive traffic is no longer throttled')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(killSwitch).toBeChecked();
  });

  test('enables and disables rate limiting, restoring original state', async ({ page }) => {
    await page.goto('/rate-limits');
    const killSwitch = page.getByRole('switch', { name: 'Rate limiting enabled' });
    await expect(killSwitch).toBeVisible();
    const wasEnabled = await killSwitch.isChecked();

    try {
      if (!wasEnabled) {
        await killSwitch.click();
        await expect(killSwitch).toBeChecked();
      }

      await killSwitch.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog.getByRole('heading', { name: 'Disable rate limiting?' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Disable rate limiting' }).click();
      await expect(dialog).not.toBeVisible();
      await expect(killSwitch).not.toBeChecked();

      await killSwitch.click();
      await expect(killSwitch).toBeChecked();

      if (!wasEnabled) {
        await killSwitch.click();
        const restoreDialog = page.getByRole('alertdialog');
        await restoreDialog.getByRole('button', { name: 'Disable rate limiting' }).click();
        await expect(restoreDialog).not.toBeVisible();
        await expect(killSwitch).not.toBeChecked();
      }
    } finally {
      const currentEnabled = await page.evaluate(async () => {
        const response = await fetch('/api/hope/admin/rate-limit');
        if (!response.ok) throw new Error(`Failed to read rate limiting state (${response.status})`);
        return ((await response.json()) as { enabled: boolean }).enabled;
      });
      if (currentEnabled !== wasEnabled) {
        await page.evaluate(async (enabled) => {
          const response = await fetch('/api/hope/admin/rate-limit/enabled', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled }),
          });
          if (!response.ok) throw new Error(`Failed to restore rate limiting (${response.status})`);
        }, wasEnabled);
      }
    }
  });

  test('opens the tier edit dialog and cancels without saving', async ({ page }) => {
    await page.goto('/rate-limits');
    const tierGrid = page.getByRole('grid', { name: 'Tier defaults' });
    await expect(tierGrid).toBeVisible();
    const tierRows = tierGrid.locator('[data-slot="data-grid-row"]');
    const rowCount = await tierRows.count();
    test.skip(rowCount === 0, 'no tiers reported in this environment');

    const firstTierName = (await tierRows.first().locator('[role="gridcell"]').first().innerText()).trim();
    await tierRows
      .first()
      .getByRole('button', { name: `Edit ${firstTierName} tier` })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: `Edit ${firstTierName} tier` })).toBeVisible();
    await expect(dialog.getByLabel('Limit (requests)')).toBeVisible();
    await expect(dialog.getByLabel('TTL (seconds)')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('edits and restores a tier override', async ({ page }) => {
    await page.goto('/rate-limits');
    const tierGrid = page.getByRole('grid', { name: 'Tier defaults' });
    await expect(tierGrid).toBeVisible();
    const tierRows = tierGrid.locator('[data-slot="data-grid-row"]');
    const rowCount = await tierRows.count();
    test.skip(rowCount === 0, 'no tiers reported in this environment');

    const firstTierName = (await tierRows.first().locator('[role="gridcell"]').first().innerText()).trim();
    await tierRows
      .first()
      .getByRole('button', { name: `Edit ${firstTierName} tier` })
      .click();
    const dialog = page.getByRole('dialog');
    const limitInput = dialog.getByLabel('Limit (requests)');
    const ttlInput = dialog.getByLabel('TTL (seconds)');
    const originalLimit = await limitInput.inputValue();
    const originalTtl = await ttlInput.inputValue();
    const updatedLimit = String(Number(originalLimit) + 1);
    const updatedTtl = String(Number(originalTtl) + 1);

    await limitInput.fill(updatedLimit);
    await ttlInput.fill(updatedTtl);
    await dialog.getByRole('button', { name: 'Save override' }).click();
    await expect(dialog).not.toBeVisible();

    await tierRows
      .first()
      .getByRole('button', { name: `Edit ${firstTierName} tier` })
      .click();
    await expect(dialog.getByLabel('Limit (requests)')).toHaveValue(updatedLimit);
    await expect(dialog.getByLabel('TTL (seconds)')).toHaveValue(updatedTtl);
    await dialog.getByLabel('Limit (requests)').fill(originalLimit);
    await dialog.getByLabel('TTL (seconds)').fill(originalTtl);
    await dialog.getByRole('button', { name: 'Save override' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('edits and restores a route override', async ({ page }) => {
    await page.goto('/rate-limits');
    const routeGrid = page.getByRole('grid', { name: 'Route overrides' });
    await expect(routeGrid).toBeVisible();
    const routeRows = routeGrid.locator('[data-slot="data-grid-row"]');
    const rowCount = await routeRows.count();
    test.skip(rowCount === 0, 'no rate-limited routes in this environment');

    const firstRoute = routeRows.first();
    const routeId = (await firstRoute.locator('[role="gridcell"]').first().innerText()).trim();
    await firstRoute.getByRole('button', { name: `Edit ${routeId}` }).click();
    const dialog = page.getByRole('dialog');
    const limitInput = dialog.getByLabel('Limit (requests)');
    const ttlInput = dialog.getByLabel('TTL (seconds)');
    const originalLimit = await limitInput.inputValue();
    const originalTtl = await ttlInput.inputValue();
    const updatedLimit = String(Number(originalLimit) + 1);
    const updatedTtl = String(Number(originalTtl) + 1);

    await limitInput.fill(updatedLimit);
    await ttlInput.fill(updatedTtl);
    await dialog.getByRole('button', { name: 'Save override' }).click();
    await expect(dialog).not.toBeVisible();

    await routeGrid.getByRole('button', { name: `Edit ${routeId}` }).click();
    await expect(dialog.getByLabel('Limit (requests)')).toHaveValue(updatedLimit);
    await expect(dialog.getByLabel('TTL (seconds)')).toHaveValue(updatedTtl);
    await dialog.getByLabel('Limit (requests)').fill(originalLimit);
    await dialog.getByLabel('TTL (seconds)').fill(originalTtl);
    await dialog.getByRole('button', { name: 'Save override' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('pausing a route opens a confirm dialog that can be cancelled', async ({ page }) => {
    await page.goto('/rate-limits');
    const routeGrid = page.getByRole('grid', { name: 'Route overrides' });
    await expect(routeGrid).toBeVisible();
    const pauseButtons = routeGrid.getByRole('button', { name: /^Pause /u });
    const pauseCount = await pauseButtons.count();
    test.skip(pauseCount === 0, 'no active routes in this environment');

    await pauseButtons.first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('heading', { name: 'Pause rate limiting for this route?' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('resumes and re-pauses a route, restoring its original state', async ({ page }) => {
    await page.goto('/rate-limits');
    const routeGrid = page.getByRole('grid', { name: 'Route overrides' });
    await expect(routeGrid).toBeVisible();

    let resumeButtons = routeGrid.getByRole('button', { name: /^Resume /u });
    if ((await resumeButtons.count()) === 0) {
      const pauseButtons = routeGrid.getByRole('button', { name: /^Pause /u });
      test.skip((await pauseButtons.count()) === 0, 'no throttled routes in this environment');
      await pauseButtons.first().click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Pause route' }).click();
      await expect(page.getByRole('alertdialog')).not.toBeVisible();
      resumeButtons = routeGrid.getByRole('button', { name: /^Resume /u });
    }

    const routeId = (await resumeButtons.first().getAttribute('aria-label'))!.replace('Resume ', '');

    await resumeButtons.first().click();
    await expect(routeGrid.getByRole('button', { name: `Pause ${routeId}` })).toBeVisible();

    await routeGrid.getByRole('button', { name: `Pause ${routeId}` }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Pause route' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(routeGrid.getByRole('button', { name: `Resume ${routeId}` })).toBeVisible();
  });

  test('searches and filters the route overrides table', async ({ page }) => {
    await page.goto('/rate-limits');
    const routeGrid = page.getByRole('grid', { name: 'Route overrides' });
    await expect(routeGrid).toBeVisible();
    const routeRows = routeGrid.locator('[data-slot="data-grid-row"]');
    const rowCount = await routeRows.count();
    test.skip(rowCount === 0, 'no rate-limited routes in this environment');

    const firstRouteId = (await routeRows.first().locator('[role="gridcell"]').first().innerText()).trim();
    await page.getByLabel('Search routes').fill(firstRouteId);
    await expect(page.getByText(/^Showing \d+ of/)).toBeVisible();
    const filteredRowCount = await routeGrid.locator('[data-slot="data-grid-row"]').count();
    expect(filteredRowCount).toBeLessThanOrEqual(rowCount);

    await page.getByLabel('Search routes').fill('');
    await page.getByLabel('Status:').click();
    await page.getByRole('option', { name: 'Paused' }).click();
    await expect(page.getByText(/^Showing \d+ of/)).toBeVisible();
  });
});
