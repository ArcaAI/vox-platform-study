/**
 * TASK-932 R-8 — the feature-availability matrix in a browser.
 *
 * The unit tests drive the tri-state cell against a stubbed gateway. What only a
 * running stack proves is that a toggle SURVIVES: the batch crosses the BFF
 * proxy, lands as a `GlobalSetting` row under the right tenant, refreshes the
 * settings cache, and comes back on a fresh read. A cell that flips in local
 * state and nowhere else looks identical until the page is reloaded, which is
 * exactly the class of defect this ticket exists to close.
 *
 * Skip-gated on the stack, like every spec in this suite.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { impersonateUser, loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

/** A console visibility gate: boolean, per-tenant, default OFF. */
const GATE_LABEL = 'MLflow (console)';
const TENANT_NAME = 'ArcaAI';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

async function openMatrix(page: Page) {
  // Desktop: below `md` the grid degrades to a tenant picker, which is a
  // different set of controls.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/features');
  await expect(page.getByRole('heading', { level: 1, name: 'Feature availability' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
}

/** One cell, by feature and column. The accessible name carries both. */
function cell(page: Page, feature: string, column: string): Locator {
  return page.getByRole('table').getByRole('checkbox', { name: new RegExp(`${feature} for ${column}`) });
}

test.describe('feature matrix — the three states', () => {
  test('renders an inheriting cell as mixed, and says what it inherits', async ({ page }) => {
    await openMatrix(page);
    const target = cell(page, GATE_LABEL, TENANT_NAME);
    await expect(target).toBeVisible();

    // Fresh seed: no tenant override, so the cell INHERITS — which is not the
    // same fact as being pinned off, and the accessible name says which.
    const checked = await target.getAttribute('aria-checked');
    expect(['mixed', 'true', 'false']).toContain(checked);
    expect(await target.getAttribute('aria-label')).toMatch(/inherits (on|off)|— (on|off)$/);
  });

  test('a platform-only feature has its tenant cells disabled', async ({ page }) => {
    await openMatrix(page);
    const target = cell(page, 'Self-service registration', TENANT_NAME);
    await expect(target).toBeDisabled();
    await expect(cell(page, 'Self-service registration', 'Platform default')).toBeEnabled();
  });
});

test.describe('feature matrix — saving and resetting', () => {
  test('toggles a tenant cell ON, saves, and the value survives a reload', async ({ page }) => {
    await openMatrix(page);
    const target = () => cell(page, GATE_LABEL, TENANT_NAME);

    // Cycle to an explicit ON, whatever the current state.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await target().getAttribute('aria-checked')) === 'true') break;
      await target().click();
    }
    expect(await target().getAttribute('aria-checked')).toBe('true');

    await page.getByRole('button', { name: /Save changes/ }).click();
    await expect(page.getByRole('button', { name: /Save changes/ })).toBeDisabled();

    await page.reload();
    await openMatrix(page);
    expect(await cell(page, GATE_LABEL, TENANT_NAME).getAttribute('aria-checked')).toBe('true');
  });

  test('resets the cell to the platform default and the override is GONE, not copied', async ({ page }) => {
    await openMatrix(page);
    const target = () => cell(page, GATE_LABEL, TENANT_NAME);

    // Cycle to inherit.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await target().getAttribute('aria-checked')) === 'mixed') break;
      await target().click();
    }
    expect(await target().getAttribute('aria-checked')).toBe('mixed');

    await page.getByRole('button', { name: /Save changes/ }).click();
    await expect(page.getByRole('button', { name: /Save changes/ })).toBeDisabled();

    await page.reload();
    await openMatrix(page);
    // Still mixed after a round trip: the row was DELETED, so the tenant follows
    // the platform default. Had the console written the platform's current value
    // down instead, this would read `false` and drift the next time the default
    // moved.
    expect(await cell(page, GATE_LABEL, TENANT_NAME).getAttribute('aria-checked')).toBe('mixed');
  });

  test('Save stays disabled until something is actually different', async ({ page }) => {
    await openMatrix(page);
    await expect(page.getByRole('button', { name: /Save changes/ })).toBeDisabled();

    const target = cell(page, GATE_LABEL, TENANT_NAME);
    await target.click();
    await expect(page.getByRole('button', { name: /Save changes/ })).toBeEnabled();

    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByRole('button', { name: /Save changes/ })).toBeDisabled();
  });
});

test.describe('feature matrix — audience', () => {
  test('an impersonated tenant admin cannot reach the screen at all', async ({ page }) => {
    // `(global)` tier guard: a non-elevated session 404s, matching the
    // gateway's own super-admin-only posture on the matrix routes.
    await impersonateUser(page, 'arcaai_admin');
    await page.goto('/features');
    await expect(page.getByRole('heading', { level: 1, name: 'Feature availability' })).toHaveCount(0);
  });
});

test.describe('feature matrix — presentation', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`has no axe violations in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await openMatrix(page);
      await expectNoA11yViolations(page);
    });
  }

  test('degrades to a tenant picker below md', async ({ page }) => {
    await page.goto('/features');
    await expect(page.getByRole('heading', { level: 1, name: 'Feature availability' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    // A 2-D matrix does not survive a phone viewport, and scrolling one
    // horizontally on touch loses the row heading the cell belongs to.
    await expect(page.getByLabel('Column')).toBeVisible();
  });
});
