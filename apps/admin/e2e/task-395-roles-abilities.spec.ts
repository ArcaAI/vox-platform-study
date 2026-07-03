/**
 * TASK-395 P1-3 — Roles & Policies richness · admin-console E2E (authored + run).
 *
 * Verifies the roles master-detail browser (indented inheritance tree + a selected
 * role's effective-abilities preview) and the SUBJECTS × ACTIONS permission matrix
 * in the policy view. Existing tabs, the CASL rule-builder + the Protected
 * affordance stay covered by task-391-roles-policies.
 *
 * Persona = superAdmin (platform RBAC). Read-only: opens the policy view then
 * dismisses; no roles/policies are mutated. Runs in all three viewports.
 *
 * @see docs/designs/admin/unbuilt-super-admin-surfaces.md §5.1
 */
import { test, expect } from './fixtures/auth';

test.describe('TASK-395 — Roles & Policies (P1-3 tree · abilities · matrix)', () => {
  test.beforeEach(async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/roles');
    await expect(page.getByRole('heading', { name: 'Roles & Policies' })).toBeVisible();
  });

  test('keeps the Roles/Policies tabs + New role affordance', async ({ page }) => {
    await expect(page.getByRole('tab', { name: 'Roles' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Policies' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New role' })).toBeVisible();
  });

  test('renders the inheritance tree with a nested child role', async ({ page }) => {
    await expect(page.getByText('Roles · inheritance')).toBeVisible();
    // Real hierarchy: DEPARTMENT_HEAD ↳ DOCTOR, SENIOR_NURSE ↳ NURSE.
    await expect(page.getByText('DOCTOR', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('DEPARTMENT_HEAD', { exact: true }).first()).toBeVisible();
  });

  test('the selected role shows an effective-abilities preview', async ({ page }) => {
    // A role auto-selects → detail renders the inheritance + abilities sections.
    await expect(page.getByText('Inheritance').first()).toBeVisible();
    await expect(page.getByText(/Effective abilities/)).toBeVisible();
  });

  test('the policy view renders a SUBJECTS × ACTIONS permission matrix', async ({ page }) => {
    await page.getByRole('tab', { name: 'Policies' }).click();
    await expect(page.getByRole('button', { name: 'New policy' })).toBeVisible();

    await page
      .getByRole('button', { name: /^View / })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Matrix header + action columns + legend.
    await expect(dialog.getByRole('columnheader', { name: 'Subject' })).toBeVisible();
    await expect(dialog.getByRole('columnheader', { name: 'read' })).toBeVisible();
    await expect(dialog.getByText('allow')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
