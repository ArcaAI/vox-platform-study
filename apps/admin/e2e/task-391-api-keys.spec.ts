/**
 * TASK-391 #23 (K5) — API Keys · admin-console E2E (authored).
 *
 * Verifies the API Keys surface (`/api-keys`) wired to `useApiKeys`, including
 * the TASK-390 **rotate** flow: a Rotate action opens a confirm explaining the
 * 24-hour grace window, then (on a live stack) reveals the new secret once.
 * Also checks the scopes column + create dialog. No role gating is asserted —
 * this is a shared-tier surface (server CASL scopes it).
 *
 * Runs in all three viewport projects (table degrades via horizontal scroll
 * below `md`).
 *
 * Run status: authored — executes only against a live admin app + seeded API.
 * Deferred this round (see README §3.5).
 *
 * @see docs/designs/admin/unbuilt-super-admin-surfaces.md §5.2
 */
import { test, expect } from './fixtures/auth';

test.describe('TASK-391 — API Keys (#23 rotate)', () => {
    // The client route `/api-keys` collides with the Vite dev-server's `/api`
    // proxy prefix: a hard `goto('/api-keys')` is forwarded to the gateway and
    // 404s (dev-only — prod serves the SPA fallback). Reach the surface the way a
    // user does — via the sidebar (client-side navigation). See TASK-391 README
    // defect D1 (recommended dev-proxy narrowing lives with the config owner).
    test.beforeEach(async ({ page, loginAs }) => {
        await loginAs('superAdmin'); // lands on /tenants with the SPA loaded
        await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible(); // shell mounted
        // Below the `md` (768px) breakpoint the sidebar collapses behind a drawer;
        // open it first (deterministic on the viewport width, not a racy probe).
        if ((page.viewportSize()?.width ?? 1280) < 768) {
            await page.getByRole('button', { name: 'Open navigation' }).click();
        }
        await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'API Keys' }).click();
        await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible();
    });

    test('renders the keys table (with Scopes) + create affordance', async ({ page }) => {
        await expect(page.getByRole('button', { name: 'New API key' })).toBeVisible();
        await expect(page.getByRole('columnheader', { name: 'Scopes' })).toBeVisible();
        await expect(page.getByRole('columnheader', { name: 'Key' })).toBeVisible();
    });

    test('create dialog opens (secret-shown-once) and dismisses', async ({ page }) => {
        await page.getByRole('button', { name: 'New API key' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel('Name')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
    });

    test('#23 · rotate opens a confirm explaining the 24-hour grace window', async ({ page }) => {
        // Target an ENABLED rotate control (its aria-label has no "(unavailable…)"
        // suffix — revoked/expired keys render a disabled Rotate instead).
        const rotate = page.getByRole('button', { name: /^Rotate [^(]+$/ }).first();
        await expect(rotate).toBeVisible();
        await rotate.click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(/24-hour grace window/i)).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Rotate key' })).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
    });
});
