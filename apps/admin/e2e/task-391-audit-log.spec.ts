/**
 * TASK-391 #25 (AU2) — Audit trail export · admin-console E2E (authored).
 *
 * Verifies the Audit Log surface (`/audit-log`) wired to `useAuditLog`, with the
 * TASK-390 multi-format export: the Export menu offers **CSV / Excel / PDF**
 * (`exportFile` for binary, `exportCsv` for text), honouring the active filters.
 *
 * Runs in all three viewport projects (the cursor `VirtualizedDataGrid` degrades
 * via horizontal scroll below `md`).
 *
 * Run status: authored — executes only against a live admin app + seeded API.
 * Deferred this round (see README §3.5).
 *
 * @see docs/designs/admin/unbuilt-super-admin-surfaces.md §5.1 (shell) / audit
 */
import { test, expect } from './fixtures/auth';

test.describe('TASK-391 — Audit Log (#25 multi-format export)', () => {
    test.beforeEach(async ({ page, loginAs }) => {
        await loginAs('superAdmin');
        await page.goto('/audit-log');
        await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible();
    });

    test('renders the cursor grid + filter fields', async ({ page }) => {
        await expect(page.locator('[role="grid"][aria-label="Audit log"]')).toBeVisible();
        // Exact match: the data-grid column headers also expose "Action" /
        // "Resource type" controls (Reorder…/…column options), so a substring
        // getByLabel is ambiguous — target the filter inputs precisely.
        await expect(page.getByLabel('Action', { exact: true })).toBeVisible();
        await expect(page.getByLabel('Resource type', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible();
    });

    test('#25 · the Export menu offers CSV, Excel and PDF', async ({ page }) => {
        await page.getByRole('button', { name: 'Export' }).click();
        await expect(page.getByRole('menuitem', { name: 'CSV (.csv)' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Excel (.xlsx)' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'PDF (.pdf)' })).toBeVisible();
        await page.keyboard.press('Escape');
    });
});
