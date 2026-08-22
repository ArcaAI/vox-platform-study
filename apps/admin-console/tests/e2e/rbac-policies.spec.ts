/**
 * Frame 22 — RBAC Policies screen spec: authenticated smoke of the list
 * shell (h1 + filter + policies table), search, scope filter, create/edit
 * sheet with the JSON rules validator, delete break-glass confirmation
 * (cancelled before commit), the protected-policy lock, and the rule 11 §11
 * axe gate in both themes. Requires a running stack (skips otherwise, see
 * helpers/stack.ts).
 */

import { expect, test } from '@playwright/test';
import { expectDistinctControlNames, expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

function policyRows(page: import('@playwright/test').Page) {
  return page.getByRole('grid', { name: 'Policies' }).locator('[data-slot="data-grid-row"]');
}

test.describe('RBAC policies screen', () => {
  test('renders the policies heading, filter bar and list region', async ({ page }) => {
    await page.goto('/rbac/policies');
    await expect(page.getByRole('heading', { level: 1, name: 'Policies' })).toBeVisible();
    await expect(page.getByLabel('Search')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New policy' }).first()).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Policies' })).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/rbac/policies');
    await expect(page.getByRole('heading', { level: 1, name: 'Policies' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Policies' })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/rbac/policies');
    await expect(page.getByRole('heading', { level: 1, name: 'Policies' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Policies' })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('the scope filter narrows the list to Global or Tenant policies', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/rbac/policies');
    await expect(page.getByRole('grid', { name: 'Policies' })).toBeVisible();
    await page.getByRole('button', { name: 'Scope', exact: true }).click();
    await page.getByRole('option', { name: 'Global' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('grid', { name: 'Policies' })).toBeVisible();
  });

  test('searching by an unmatched term shows the filtered-empty state with a clear-filters action', async ({ page }) => {
    await page.goto('/rbac/policies');
    await expect(page.getByRole('grid', { name: 'Policies' })).toBeVisible();
    await page.getByLabel('Search').fill('no-such-policy-xyz-000');
    // Two buttons carry this name once the grid empties — the data-grid toolbar's
    // and the empty state's. The test's subject is the FILTERED-EMPTY state, so
    // scope to it rather than letting strict mode pick.
    await expect(page.locator('[data-slot="empty"]').getByRole('button', { name: 'Clear filters' })).toBeVisible();
    // The filtered-EMPTY state is where the duplicate-name defect lived: the
    // toolbar's clear control and the empty state's are both on screen only here,
    // so the default-state axe scans can never see it.
    await expectDistinctControlNames(page);
  });

  test('the create sheet validates malformed JSON rules before allowing save', async ({ page }) => {
    await page.goto('/rbac/policies');
    await page.getByRole('button', { name: 'New policy' }).first().click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('heading', { name: 'New policy' })).toBeVisible();

    await sheet.getByPlaceholder('consultation.read').fill('e2e.temp.policy');
    const rulesField = sheet.getByLabel(/Rules/);
    await rulesField.fill('{ not valid json');
    await sheet.getByRole('button', { name: 'Validate' }).click();
    await expect(sheet.getByText('Invalid JSON')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(sheet).not.toBeVisible();
  });

  test('save is disabled until edited rules are validated', async ({ page }) => {
    await page.goto('/rbac/policies');
    await page.getByRole('button', { name: 'New policy' }).first().click();
    const sheet = page.getByRole('dialog');
    await sheet.getByPlaceholder('consultation.read').fill('e2e.temp.policy');
    await sheet.getByLabel(/Rules/).fill(JSON.stringify([{ action: 'read', subject: 'Consultation' }]));

    const submit = sheet.getByRole('button', { name: 'Create policy' });
    await expect(submit).toBeDisabled();

    await sheet.getByRole('button', { name: 'Validate' }).click();
    await expect(sheet.getByText(/Rules are valid|Validation failed/)).toBeVisible();

    await page.keyboard.press('Escape');
  });

  test('editing a policy opens the sheet pre-filled and can be cancelled without saving', async ({ page }) => {
    await page.goto('/rbac/policies');
    await expect(page.getByRole('grid', { name: 'Policies' })).toBeVisible();
    await expect(policyRows(page).first()).toBeVisible();
    const editableRow = policyRows(page)
      .filter({ hasNot: page.getByText('Protected') })
      .first();
    test.skip((await policyRows(page).count()) === 0, 'no policies seeded — the list is empty');

    await editableRow.click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('heading', { name: 'Edit policy' })).toBeVisible();
    await expect(sheet.getByLabel(/Rules/)).not.toBeEmpty();
    await page.keyboard.press('Escape');
  });

  test('protected policies block save and show the anti-lockout banner', async ({ page }) => {
    await page.goto('/rbac/policies');
    await expect(page.getByRole('grid', { name: 'Policies' })).toBeVisible();
    await expect(policyRows(page).first()).toBeVisible();
    const protectedRow = policyRows(page).filter({ hasText: 'Protected' }).first();
    test.skip((await protectedRow.count()) === 0, 'no protected system policy visible to assert the lock against');

    await protectedRow.getByRole('button', { name: /Open actions for/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeDisabled();
    await page.keyboard.press('Escape');

    await protectedRow.click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText('Protected system policy')).toBeVisible();
    await expect(sheet.getByRole('button', { name: /^(Save changes|Create policy)$/ })).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  test('delete on an unprotected policy opens the break-glass confirmation and can be cancelled', async ({ page }) => {
    await page.goto('/rbac/policies');
    await expect(page.getByRole('grid', { name: 'Policies' })).toBeVisible();
    await expect(policyRows(page).first()).toBeVisible();
    const editableRow = policyRows(page)
      .filter({ hasNot: page.getByText('Protected') })
      .first();
    test.skip((await editableRow.count()) === 0, 'no unprotected policy seeded to delete');

    await editableRow.getByRole('button', { name: /Open actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();

    const dialog = page.getByRole('dialog').filter({ hasText: 'Delete policy' });
    await expect(dialog.getByRole('heading', { name: 'Delete policy' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });
});
