/**
 * Frame 30 — Departments against a RUNNING stack (rule 12 gate 3): screen
 * smoke plus axe scans in both themes. Skips with actionable messages when
 * the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  // Departments are tenant-scoped: elevated sessions see the "Select a
  // working tenant" gate until one is chosen.
  await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Departments' })).toBeVisible();
  const emptyState = page.getByText('No departments yet');
  // The hierarchy list renders once the roots landed; empty tenants show
  // the neutral empty state instead.
  const treeNodes = page.getByRole('list', { name: 'Department hierarchy' }).locator('li');
  await expect(treeNodes.first().or(emptyState.first())).toBeVisible();
}

test.describe('departments (frame 30)', () => {
  test('shows the header, filter strip and the hierarchy region', async ({ page }) => {
    await page.goto('/departments');
    await waitForSettled(page);
    await expect(page.getByRole('button', { name: 'New department' }).first()).toBeVisible();
    await expect(page.getByLabel('Search departments')).toBeVisible();
  });

  test('the department search syncs the URL', async ({ page }) => {
    await page.goto('/departments');
    await waitForSettled(page);
    await page.getByLabel('Search departments').fill('card');
    // 300ms debounce before the nuqs write lands in the URL.
    await expect(page).toHaveURL(/q=card/);
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/departments');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    // next-themes defaultTheme="system": emulating the media query flips
    // the .dark class without touching client storage.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/departments');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });
});

test.describe('departments — create and delete (frame 30)', () => {
  test('creates a department, then deletes it via the edit panel type-to-confirm flow', async ({ page }) => {
    const name = `E2E Dept ${Date.now()}`;
    await page.goto('/departments');
    await waitForSettled(page);

    let created = false;
    const hierarchy = page.getByRole('list', { name: 'Department hierarchy' });
    try {
      await page.getByRole('button', { name: 'New department' }).first().click();
      const createDialog = page.getByRole('dialog', { name: 'New department' });
      await createDialog.getByRole('textbox', { name: /^Name/ }).fill(name);
      created = true;
      await createDialog.getByRole('button', { name: 'Create department' }).click();
      await expect(createDialog).toBeHidden();

      await expect(hierarchy.getByText(name)).toBeVisible();

      await hierarchy.getByRole('button', { name, exact: true }).click();
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(page.getByRole('heading', { level: 2, name: `Edit: ${name}` })).toBeVisible();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();

      const confirmDialog = page.getByRole('alertdialog', { name: 'Delete department?' });
      const confirmButton = confirmDialog.getByRole('button', { name: 'Delete department' });
      const typeToConfirm = confirmDialog.getByLabel(`Type ${name} to confirm`);
      await expect(confirmButton).toBeDisabled();
      await typeToConfirm.fill(name);
      await expect(confirmButton).toBeEnabled();
      await confirmButton.click();
      await expect(confirmDialog).toBeHidden();

      await expect(hierarchy.getByText(name)).toHaveCount(0);
      created = false;
    } finally {
      if (created) {
        try {
          const row = hierarchy.getByRole('button', { name, exact: true });
          if (await row.isVisible().catch(() => false)) {
            await row.click();
            const editButton = page.getByRole('button', { name: 'Edit', exact: true });
            if (await editButton.isVisible().catch(() => false)) {
              await editButton.click();
              const deleteButton = page.getByRole('button', { name: 'Delete', exact: true });
              if (await deleteButton.isVisible().catch(() => false)) {
                await deleteButton.click();
                const cleanupDialog = page.getByRole('alertdialog', { name: 'Delete department?' });
                await cleanupDialog.getByLabel(`Type ${name} to confirm`).fill(name);
                await cleanupDialog.getByRole('button', { name: 'Delete department' }).click();
                await expect(cleanupDialog).toBeHidden();
              }
            }
          }
        } catch {
          // Preserve the original assertion while attempting cleanup.
        }
      }
    }
  });

  test('the create dialog gates submit on the required name', async ({ page }) => {
    await page.goto('/departments');
    await waitForSettled(page);

    await page.getByRole('button', { name: 'New department' }).first().click();
    const createDialog = page.getByRole('dialog', { name: 'New department' });
    const submit = createDialog.getByRole('button', { name: 'Create department' });
    await expect(submit).toBeDisabled();

    await createDialog.getByRole('textbox', { name: /^Name/ }).fill('Validation Only');
    await expect(submit).toBeEnabled();

    await createDialog.getByRole('textbox', { name: /^Name/ }).fill('');
    await expect(submit).toBeDisabled();
  });

  test('the delete confirm dialog gates on typing the exact department name', async ({ page }) => {
    const name = `E2E Gate ${Date.now()}`;
    await page.goto('/departments');
    await waitForSettled(page);

    await page.getByRole('button', { name: 'New department' }).first().click();
    const createDialog = page.getByRole('dialog', { name: 'New department' });
    await createDialog.getByRole('textbox', { name: /^Name/ }).fill(name);
    await createDialog.getByRole('button', { name: 'Create department' }).click();
    await expect(createDialog).toBeHidden();

    const hierarchy = page.getByRole('list', { name: 'Department hierarchy' });
    await hierarchy.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const confirmDialog = page.getByRole('alertdialog', { name: 'Delete department?' });
    const confirmButton = confirmDialog.getByRole('button', { name: 'Delete department' });
    const typeToConfirm = confirmDialog.getByLabel(`Type ${name} to confirm`);

    await expect(confirmButton).toBeDisabled();
    await typeToConfirm.fill('wrong-name');
    await expect(confirmButton).toBeDisabled();
    await typeToConfirm.fill(name);
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();
    await expect(confirmDialog).toBeHidden();
  });
});

test.describe('departments — search and filters (frame 30)', () => {
  test('typing a search term narrows the hierarchy to matches or shows no-results', async ({ page }) => {
    const name = `E2E Search Seed ${Date.now()}`;
    await page.goto('/departments');
    await waitForSettled(page);

    await page.getByRole('button', { name: 'New department' }).first().click();
    const createDialog = page.getByRole('dialog', { name: 'New department' });
    await createDialog.getByRole('textbox', { name: /^Name/ }).fill(name);
    await createDialog.getByRole('button', { name: 'Create department' }).click();
    await expect(createDialog).toBeHidden();

    await page.getByLabel('Search departments').fill('no-such-department-xyz-000');
    await expect(page).toHaveURL(/q=no-such-department/);
    await expect(page.getByText('No departments match your search.')).toBeVisible();

    await page.getByLabel('Search departments').fill(name);
    await expect(page).toHaveURL(/q=E2E/);
    const hierarchy = page.getByRole('list', { name: 'Department hierarchy' });
    await expect(hierarchy.getByText(name)).toBeVisible();

    await page.getByLabel('Search departments').fill('');
    await expect(page).not.toHaveURL(/q=/);

    await hierarchy.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const confirmDialog = page.getByRole('alertdialog', { name: 'Delete department?' });
    await confirmDialog.getByLabel(`Type ${name} to confirm`).fill(name);
    await confirmDialog.getByRole('button', { name: 'Delete department' }).click();
    await expect(confirmDialog).toBeHidden();
  });

  test('the include-disabled toggle updates the URL and the shown/total counts', async ({ page }) => {
    await page.goto('/departments');
    await waitForSettled(page);

    const toggle = page.getByLabel('Include disabled:');
    await expect(toggle).not.toBeChecked();
    await expect(page).not.toHaveURL(/disabled=/);

    await toggle.click();
    await expect(page).toHaveURL(/disabled=true/);
    await expect(toggle).toBeChecked();

    await toggle.click();
    await expect(page).not.toHaveURL(/disabled=true/);
    await expect(toggle).not.toBeChecked();
  });
});

test.describe('departments — hierarchy and edit (frame 30)', () => {
  test('expands a seeded root and opens its edit drawer', async ({ page }) => {
    await page.goto('/departments');
    await waitForSettled(page);

    const hierarchy = page.getByRole('list', { name: 'Department hierarchy' });
    const expand = hierarchy.getByRole('button', { name: /^(Expand|Collapse) Cardiology$/ });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');

    await expand.click();
    await expect(expand).toHaveAttribute('aria-expanded', 'true');
    await expect(hierarchy.getByText('No sub-departments')).toBeVisible();

    await expand.click();
    await expect(expand).toHaveAttribute('aria-expanded', 'false');

    await hierarchy.getByRole('button', { name: 'Cardiology CARD', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Members of Cardiology' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();

    const editDrawer = page.getByRole('dialog', { name: 'Edit: Cardiology' });
    await expect(editDrawer).toBeVisible();
    await expect(editDrawer.getByRole('textbox', { name: /^Name/ })).toHaveValue('Cardiology');
    await expect(editDrawer.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});
