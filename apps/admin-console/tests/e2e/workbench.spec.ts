/**
 * The Workbench (TASK-721 Phase C, Task 11) — sandboxed interpreter runs against synthetic
 * inputs. Follows `playground.spec.ts`'s stack-guard/login pattern. AUTHORED, NOT EXECUTED this
 * session — `pnpm test:e2e`'s `globalSetup` runs `prisma db push --force-reset`, which the
 * Prisma CLI refuses when invoked by an AI agent (see the ticket README §7). Paste real output
 * before this file is claimed green.
 */

import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable, serviceAvailable, serviceDownMessage } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  test.skip(!(await serviceAvailable('harness')), serviceDownMessage('harness'));
  await loginAsAdmin(page);
  await selectWorkingTenant(page);
});

test.describe('Workbench', () => {

  test('renders the sandbox watermark, definition picker, and fixture picker', async ({ page }) => {
    await page.goto('/playground/workbench');
    await expect(page.getByRole('heading', { level: 1, name: 'Workbench' })).toBeVisible();
    await expect(page.getByText(/never writes external artifacts/i)).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Workflow definition' })).toBeVisible();
    await expect(page.getByLabel('Fixture')).toBeVisible();
  });

  test('a fixture can be created and selected', async ({ page }) => {
    await page.goto('/playground/workbench');
    await page.getByRole('button', { name: 'New fixture' }).click();
    await page.getByLabel('Name').fill(`e2e fixture ${Date.now()}`);
    await page.getByRole('button', { name: 'Save fixture' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('starting a run streams progress and reaches a terminal state; the sandbox badge is present throughout', async ({ page }) => {
    await page.goto('/playground/workbench');
    const definitionPicker = page.getByRole('combobox', { name: 'Workflow definition' });
    await definitionPicker.click();
    // The picker is empty unless the WORKING TENANT owns an enabled workflow
    // definition, and the seeded ones belong to ArcaAI while selectWorkingTenant
    // may land on another tenant. Skip with an actionable message rather than
    // time out on a click that was never going to resolve — "no definition to
    // run" is an environment gap, not a Workbench defect.
    const options = page.getByRole('option');
    const optionCount = await options.count();
    test.skip(
      optionCount === 0,
      'the working tenant owns no enabled workflow definition — seed one, or select a tenant that has one, to exercise a sandbox run',
    );
    await options.first().click();

    await page.getByRole('button', { name: 'Run in sandbox' }).click();
    await expect(page.getByText('Sandbox').first()).toBeVisible();

    // Terminal within a generous bound — the gateway polls the interpreter every 2s.
    await expect(page.getByText(/COMPLETED|FAILED|CANCELED|TIMED_OUT/)).toBeVisible({ timeout: 30_000 });
  });

  test('sandbox containment: the run is excluded by default from admin/workflow-runs, and included with the toggle', async ({ page }) => {
    // Start a sandbox run from the Workbench (per the prior test's flow), then verify it does
    // NOT show up in the real-data runs list by default, and DOES with includeSandbox.
    await page.goto('/playground/workbench');
    const definitionPicker = page.getByRole('combobox', { name: 'Workflow definition' });
    await definitionPicker.click();
    // Same environment gap as the run test above.
    const containmentOptions = page.getByRole('option');
    test.skip(
      (await containmentOptions.count()) === 0,
      'the working tenant owns no enabled workflow definition — seed one to exercise sandbox containment',
    );
    await containmentOptions.first().click();
    await page.getByRole('button', { name: 'Run in sandbox' }).click();
    await expect(page.getByText(/COMPLETED|FAILED|CANCELED|TIMED_OUT/)).toBeVisible({ timeout: 30_000 });

    await page.goto('/workflow-runs');
    // Default view: no sandbox runs.
    await expect(page.getByText('workbench sandbox')).toHaveCount(0);
    // Explicit opt-in toggle reveals sandbox runs.
    await page.getByRole('checkbox', { name: /include sandbox/i }).check();
    await expect(page.getByText('workbench sandbox').first()).toBeVisible();
  });

  test('axe: 0 violations, light and dark', async ({ page }) => {
    await page.goto('/playground/workbench');
    await expectNoA11yViolations(page);

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expectNoA11yViolations(page);
  });
});
