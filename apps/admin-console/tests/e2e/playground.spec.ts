/**
 * Tier 50–59 Playground — now rendered INSIDE the console shell (TASK-502
 * supersedes the TASK-442 no-shell "impersonation canvas" decision). Verifies
 * against a RUNNING stack: the admin sidebar + topbar are present, the
 * content-level persona control still works, and — the BUG-005 Issue 3 fix —
 * an impersonated tenant-bound user's screens render real content instead of
 * the "Select a working tenant" gate. Skips with actionable messages when the
 * app or gateway is down.
 */

import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { impersonateUser, loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
});

test.describe('playground inside the console shell (TASK-502)', () => {
    test('renders with the admin sidebar + persona control, same as any other console screen', async ({ page }) => {
        // Voice profiles is user-owned (no working-tenant gate) — the most
        // robust page to assert the shared shell on.
        await page.goto('/playground/voice-profiles');
        await expect(page.getByRole('heading', { level: 1, name: 'My Voice Enrollment & Profiles' })).toBeVisible();

        // The console shell is present — sidebar landmark + its toggle.
        await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
        await expect(page.getByRole('button', { name: /toggle sidebar/i })).toBeVisible();

        // Content-level persona/impersonation control (TASK-502, ex-top-bar).
        await expect(page.getByRole('button', { name: /acting as/i })).toBeVisible();
        // The under-admin line (not the page description, which also contains "under").
        await expect(page.getByText(/^under \S/i)).toBeVisible();
    });

    test('nav labels are reflected via the sidebar and breadcrumb', async ({ page }) => {
        await page.goto('/playground/llm');
        await expect(page.getByText('Agent Playground').first()).toBeVisible();
        await expect(page.getByRole('link', { name: 'Agent Playground' })).toBeVisible();
    });

    test('impersonating a tenant-bound user renders real content, not the working-tenant gate (BUG-005)', async ({ page }) => {
        await impersonateUser(page, 'doctor2');

        // No 400s from a stale/missing X-Tenant-Id while impersonating —
        // observe the actual proxied responses, don't replay them (some are
        // mutations).
        const proxyStatuses: Array<{ url: string; status: number }> = [];
        page.on('response', (response) => {
            if (response.url().includes('/api/hope/')) proxyStatuses.push({ url: response.url(), status: response.status() });
        });

        await page.goto('/playground/llm');
        await expect(page.getByRole('heading', { level: 1, name: 'Agent Playground' })).toBeVisible();
        await expect(page.getByText('Select a working tenant')).toHaveCount(0);
        await expect(page.getByRole('tab', { name: 'Text generation' })).toBeVisible();

        for (const { url, status } of proxyStatuses) {
            expect(status, url).not.toBe(400);
        }
    });

    test('Agent Playground exposes Text generation / Guardrails / NER tabs', async ({ page }) => {
        // The Agent Playground is tenant-scoped (WorkingTenantGate): select a working
        // tenant BEFORE navigating so the gate opens on first render. A working admin
        // uses the TenantSwitcher in the console SiteHeader (TASK-502).
        await selectWorkingTenant(page);
        await page.goto('/playground/llm');
        await expect(page.getByRole('tab', { name: 'Text generation' })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Guardrails' })).toBeVisible();
        // exact: "NER" is a substring of "Text geNERation".
        await expect(page.getByRole('tab', { name: 'NER', exact: true })).toBeVisible();

        // Guardrails/NER are wired to the ai/* gateway proxy (TASK-446).
        await page.getByRole('tab', { name: 'Guardrails' }).click();
        await expect(page.getByRole('button', { name: /analyze/i })).toBeVisible();
        await page.getByRole('tab', { name: 'NER', exact: true }).click();
        await expect(page.getByRole('button', { name: /extract/i })).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/playground/voice-profiles');
        await expect(page.getByRole('heading', { level: 1, name: 'My Voice Enrollment & Profiles' })).toBeVisible();
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/playground/voice-profiles');
        await expect(page.getByRole('heading', { level: 1, name: 'My Voice Enrollment & Profiles' })).toBeVisible();
        await expectNoA11yViolations(page);
    });
});
