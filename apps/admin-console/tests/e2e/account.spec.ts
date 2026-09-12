/**
 * Frame 25 (account half) — Account screen spec: authenticated smoke of the
 * session identity region, the my-settings inline edit flow (per-row
 * dirty-gated save), the preferences form (dirty-gated save across three
 * fields), and the rule 11 §11 axe gate in both themes. Requires a running
 * stack (skips otherwise).
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { ADMIN_CREDENTIALS, API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  await selectWorkingTenant(page);
});

test.describe('account screen', () => {
  test('renders the identity region from the BFF session', async ({ page }) => {
    await page.goto('/account');
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    const identity = page.getByRole('region', { name: 'Identity' });
    await expect(identity).toBeVisible();
    await expect(identity).toContainText(ADMIN_CREDENTIALS.username);
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/account');
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Identity' })).toBeVisible();
    await expect(page.getByLabel('Workflow mode')).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/account');
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Identity' })).toBeVisible();
    await expect(page.getByLabel('Workflow mode')).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('renders the my-settings and preferences sections', async ({ page }) => {
    await page.goto('/account');
    await expect(page.getByRole('heading', { level: 2, name: 'My settings' })).toBeVisible();
    const preferences = page.getByRole('region', { name: 'Preferences' });
    await expect(preferences).toBeVisible();
    const workflowField = preferences.getByLabel('Workflow mode');
    await expect(workflowField).toBeVisible();
    await expect(preferences.getByLabel('Language', { exact: true })).toBeVisible();
    await expect(preferences.getByLabel('DNA style ID')).toBeVisible();
  });

  test('the my-settings section explains where app settings are stored', async ({ page }) => {
    await page.goto('/account');
    const mySettings = page.getByRole('region', { name: 'My settings' });
    await expect(mySettings).toBeVisible();
    await expect(mySettings).toContainText('Raw key-value settings written by the apps you use.');
    await expect(mySettings).toContainText('Theme Preference');
    await expect(mySettings.getByLabel('Value for theme')).toHaveValue('dark');
  });

  test('an editable "my setting" row enables save only once its value is changed', async ({ page }) => {
    await page.goto('/account');
    const mySettings = page.getByRole('region', { name: 'My settings' });
    const editableInput = mySettings.locator('input[aria-label^="Value for "]:not([disabled])').first();
    await expect(editableInput).toBeVisible();

    const ariaLabel = await editableInput.getAttribute('aria-label');
    const key = ariaLabel?.replace('Value for ', '') ?? '';
    const saveButton = page.getByRole('button', { name: `Save ${key}` });
    await expect(saveButton).toBeDisabled();

    const original = await editableInput.inputValue();
    await editableInput.fill(`${original}-e2e-untouched`);
    await expect(saveButton).toBeEnabled();

    await editableInput.fill(original);
    await expect(saveButton).toBeDisabled();
  });

  test('seeded "my setting" rows expose namespaced edit controls', async ({ page }) => {
    await page.goto('/account');
    const mySettings = page.getByRole('region', { name: 'My settings' });
    const settingInput = mySettings.locator('input[aria-label^="Value for "]').first();
    await expect(settingInput).toBeVisible();
    await expect(settingInput).toBeEnabled();
    await expect(mySettings.getByText('ui', { exact: true })).toBeVisible();

    const ariaLabel = await settingInput.getAttribute('aria-label');
    const key = ariaLabel?.replace('Value for ', '') ?? '';
    await expect(page.getByRole('button', { name: `Save ${key}` })).toBeDisabled();
  });

  test('save preferences enables only once a field changes, and reflects back after saving', async ({ page }) => {
    await page.goto('/account');
    const preferences = page.getByRole('region', { name: 'Preferences' });
    const languageInput = preferences.getByLabel('Language', { exact: true });
    await expect(languageInput).toBeVisible();
    const saveButton = page.getByRole('button', { name: 'Save preferences' });
    await expect(saveButton).toBeDisabled();

    const original = await languageInput.inputValue();
    const temp = `${original}-e2e-temp`;
    try {
      await languageInput.fill(temp);
      await expect(saveButton).toBeEnabled();
      await saveButton.click();

      await expect(page.getByText('Preferences saved')).toBeVisible();
      await expect(saveButton).toBeDisabled();
    } finally {
      await languageInput.fill(original);
      if (original.length > 0) {
        await saveButton.click();
        await expect(page.getByText('Preferences saved')).toBeVisible();
      }
    }
  });

  test('workflow mode offers local and remote options', async ({ page }) => {
    await page.goto('/account');
    const preferences = page.getByRole('region', { name: 'Preferences' });
    const workflowField = preferences.getByLabel('Workflow mode');
    await expect(workflowField).toBeVisible();
    await workflowField.click();
    await expect(page.getByRole('option', { name: 'Local (on-device pipeline)' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Remote (server pipeline)' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('a locked transcription mode shows the admin-locked badge', async ({ page }) => {
    await page.goto('/account');
    const preferences = page.getByRole('region', { name: 'Preferences' });
    const workflowField = preferences.getByLabel('Workflow mode');
    await expect(workflowField).toBeVisible();
    // The badge renders only when the tenant has locked the transcription mode
    // (`preferences.transcriptionModeLocked`). This test asserted it
    // unconditionally, so it failed on every tenant without that config. Ask the
    // API whether the lock exists, so "not configured" SKIPS with an actionable
    // message while "configured but not rendered" still FAILS — the distinction
    // an unconditional assertion threw away.
    const locked = await page.evaluate(async () => {
      const response = await fetch('/api/hope/users/me/preferences');
      if (!response.ok) return null;
      const body = (await response.json()) as { transcriptionModeLocked?: boolean };
      return body.transcriptionModeLocked === true;
    });
    test.skip(locked !== true, 'no admin-locked transcription mode on this tenant — set preferences.transcriptionModeLocked to exercise the badge');

    await expect(page.getByText('Locked by admin')).toBeVisible();
  });
});

/**
 * Tenant profile (/tenant-profile, tier 20-29): profile tabs + Settings
 * category sub-nav. The seeded super admin may have no working tenant, so
 * every check tolerates the NoTenant empty state as a valid outcome.
 */

/** The tabbed profile OR the frame's NoTenant variant — either is a loaded state. */
function tabsOrEmpty(page: Page) {
  return page.getByRole('tab', { name: 'Organization' }).or(page.getByText('No working tenant selected'));
}

test.describe('tenant profile — tabs + settings pointer', () => {
  test('renders the two profile tabs (or the no-tenant empty state)', async ({ page }) => {
    await page.goto('/tenant-profile');
    await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();
    await expect(tabsOrEmpty(page).first()).toBeVisible();

    if (await page.getByRole('tab', { name: 'Organization' }).isVisible()) {
      await expect(page.getByRole('tab', { name: 'Plan & usage' })).toBeVisible();
      // TASK-956: no Settings tab — /settings and /settings-registry own those rows.
      await expect(page.getByRole('tab', { name: 'Settings' })).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Organization' })).toBeVisible();
    }
  });

  test('deep-links to the Plan & usage tab via ?tab=', async ({ page }) => {
    await page.goto('/tenant-profile?tab=plan');
    await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();
    // Plan region when a tenant is selected; otherwise the no-tenant gate.
    await expect(page.getByRole('region', { name: 'Plan & usage' }).or(page.getByText('No working tenant selected')).first()).toBeVisible();
  });

  test('the Organization tab points at the settings editors (or shows the no-tenant state)', async ({ page }) => {
    // The retired ?tab=settings deep link lands on Organization (TASK-956).
    await page.goto('/tenant-profile?tab=settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();

    const pointer = page.getByRole('region', { name: 'Settings' });
    const noTenant = page.getByText('No working tenant selected');
    await expect(pointer.or(noTenant).first()).toBeVisible();

    if (await pointer.isVisible()) {
      await expect(page.getByRole('tab', { name: 'Organization', selected: true })).toBeVisible();
      await expect(pointer.getByRole('link', { name: /Settings registry/ })).toHaveAttribute('href', '/settings-registry');
      await expect(pointer.getByRole('link', { name: /Settings rows & secrets/ })).toHaveAttribute('href', '/settings');
    } else {
      await expect(noTenant).toBeVisible();
    }
  });

  test('has no WCAG 2.2 AA violations on the Organization tab with the settings pointer (light + dark)', async ({ page }) => {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto('/tenant-profile');
      await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();
      await expect(tabsOrEmpty(page).first()).toBeVisible();
      await expectNoA11yViolations(page);
    }
  });
});
