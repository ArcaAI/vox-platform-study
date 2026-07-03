/**
 * TASK-403 — Super-admin ops surfaces (Rate Limits · Queues & Jobs · Prisma Studio).
 *
 * Browser-driven, full-stack (Vite :5174 → API :8868). Run with a seeded test
 * stack: `SKIP_DB_PRECHECK=true pnpm exec playwright test --config apps/admin/playwright.config.ts task-403`.
 *
 * Coverage:
 *   nav    · super-admin sees the OPERATIONS section (Rate Limits, Queues &
 *            Jobs, Prisma Studio) + the Developer/Components entry; a doctor
 *            sees none of them (drawer-aware on mobile).
 *   guard  · tenant_admin direct-URL hits on all three routes are bounced by
 *            the `requireSuperAdmin` beforeLoad (mirrors task-394 pattern).
 *   14     · Rate Limits renders the kill-switch card, 4 tier cards and the
 *            route-overrides table (auth.login present); kill-switch ON → OFF
 *            round-trip through the real UI — ALWAYS ends OFF (desktop only).
 *   15     · Queues & Jobs renders the Redis health strip (healthy), the
 *            queues table (AuditLog + IngestKnowledgeDocument rows), keeps
 *            Pause/Clean DISABLED (non-destructive constraint), and opens the
 *            jobs drawer with the PII-redaction caption (desktop only).
 *   16     · Prisma Studio renders the status card as Disabled (test env is
 *            fail-closed) with no "Open Prisma Studio" action.
 *
 * Non-destructive: the only mutation is the rate-limit kill-switch round-trip,
 * which restores OFF (the required hand-off state) before the test ends.
 */
import type { Page } from '@playwright/test';
import { test, expect, type PersonaKey } from './fixtures/auth';

const OPS_LINKS = ['Rate Limits', 'Queues & Jobs', 'Prisma Studio'] as const;

/** Login, land on /tenants, then return the Primary nav (opening the mobile drawer when collapsed). */
async function primaryNav(page: Page, loginAs: (p: PersonaKey) => Promise<void>, persona: PersonaKey) {
  await loginAs(persona);
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  return page.getByRole('navigation', { name: 'Primary' });
}

// =============================================================================
// Navigation visibility (all viewports)
// =============================================================================
test.describe('TASK-403 — Operations nav visibility', () => {
  test('super-admin sees all three Operations entries + Developer/Components', async ({ page, loginAs }) => {
    const nav = await primaryNav(page, loginAs, 'superAdmin');
    for (const label of OPS_LINKS) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: 'Components' })).toBeVisible();
  });

  test('doctor sees neither the Operations entries nor Components', async ({ page, loginAs }) => {
    const nav = await primaryNav(page, loginAs, 'doctor');
    await expect(nav.getByRole('link', { name: 'Users' })).toBeVisible(); // nav rendered
    for (const label of [...OPS_LINKS, 'Components']) {
      await expect(nav.getByRole('link', { name: label })).toHaveCount(0);
    }
  });
});

// =============================================================================
// Route guard (all viewports; mirrors task-394-superadmin-guard)
// =============================================================================
test.describe('TASK-403 — requireSuperAdmin route guard', () => {
  const GUARDED = [
    { path: '/rate-limits', heading: 'Rate Limits' },
    { path: '/queues', heading: 'Queues & Jobs' },
    { path: '/prisma-studio', heading: 'Prisma Studio' },
  ] as const;

  test('super-admin opens each ops surface directly', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    for (const { path, heading } of GUARDED) {
      await page.goto(path);
      await page.waitForURL(`**${path}`, { timeout: 15_000 });
      // exact: the Prisma Studio page also renders a "Prisma Studio shell" card heading.
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
  });

  test('tenant-admin is bounced off every ops surface on a direct URL hit', async ({ page, loginAs }) => {
    await loginAs('tenantAdmin');
    for (const { path, heading } of GUARDED) {
      await page.goto(path);
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).not.toBe(path);
      await expect(page.getByRole('heading', { name: heading })).toHaveCount(0);
    }
  });
});

// =============================================================================
// Surface 14 — Rate Limits
// =============================================================================
test.describe('TASK-403 — Rate Limits surface', () => {
  test('renders kill-switch, four tier cards and the route-overrides table', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/rate-limits');
    await expect(page.getByRole('heading', { name: 'Rate Limits' })).toBeVisible();

    // Kill-switch card reflects the OFF hand-off state with db provenance.
    await expect(page.getByRole('switch', { name: 'Rate limiting kill-switch' })).toBeVisible();
    await expect(page.getByText('Rate limiting · Off')).toBeVisible();

    // Four tier baselines, strict flagged auth-critical.
    for (const tier of ['default', 'strict', 'heavy', 'relaxed']) {
      await expect(page.getByTestId(`tier-card-${tier}`)).toBeVisible();
    }
    await expect(page.getByTestId('tier-card-strict').getByText('Auth-critical', { exact: true })).toBeVisible();

    // Route overrides — known throttled routes with provenance badges.
    await expect(page.getByTestId('route-row-auth.login')).toBeVisible();
    await expect(page.getByTestId('route-row-auth.impersonate')).toBeVisible();

    // Kill-switch OFF state surfaces the inert-config warning (design state).
    await expect(page.getByText('Throttling disabled platform-wide')).toBeVisible();
  });

  test('kill-switch round-trip through the UI: ON → verified → OFF (hand-off state)', async ({ page, loginAs }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'single-viewport mutation — one ON/OFF round-trip is enough');

    await loginAs('superAdmin');
    await page.goto('/rate-limits');
    const killSwitch = page.getByRole('switch', { name: 'Rate limiting kill-switch' });
    await expect(killSwitch).toBeEnabled();
    await expect(page.getByText('Rate limiting · Off')).toBeVisible();

    // ON — the caption flips and the inert-config warning clears.
    await killSwitch.click();
    await expect(page.getByText('Rate limiting · On')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Throttling disabled platform-wide')).toHaveCount(0);

    // OFF — REQUIRED hand-off state.
    await expect(killSwitch).toBeEnabled();
    await killSwitch.click();
    await expect(page.getByText('Rate limiting · Off')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Throttling disabled platform-wide')).toBeVisible();
  });
});

// =============================================================================
// Surface 15 — Queues & Jobs
// =============================================================================
test.describe('TASK-403 — Queues & Jobs surface', () => {
  test('renders Redis health strip and the queues table with disabled destructive actions', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/queues');
    await expect(page.getByRole('heading', { name: 'Queues & Jobs' })).toBeVisible();

    // Redis health strip — live test Redis is healthy.
    const redisCard = page.getByTestId('redis-health-card');
    await expect(redisCard.getByText('Redis healthy')).toBeVisible({ timeout: 15_000 });
    await expect(redisCard.getByText(/\d+ queues/)).toBeVisible();

    // Registered platform queues render as rows.
    await expect(page.getByTestId('queue-row-AuditLog')).toBeVisible();
    await expect(page.getByTestId('queue-row-IngestKnowledgeDocument')).toBeVisible();

    // Non-destructive constraint: Pause/Clean exist per the design but are DISABLED.
    const auditRow = page.getByTestId('queue-row-AuditLog');
    await expect(auditRow.getByRole('button', { name: 'Pause AuditLog (disabled)' })).toBeDisabled();
    await expect(auditRow.getByRole('button', { name: 'Clean AuditLog (disabled)' })).toBeDisabled();
  });

  test('queue click opens the jobs drawer with the PII-redaction caption', async ({ page, loginAs }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'drawer interaction covered once; layout tiers covered by render test');

    await loginAs('superAdmin');
    await page.goto('/queues');
    await expect(page.getByTestId('queue-row-IngestKnowledgeDocument')).toBeVisible();

    await page.getByTestId('queue-row-IngestKnowledgeDocument').getByRole('button', { name: 'IngestKnowledgeDocument', exact: true }).click();

    // Sheet header + the non-destructive caption from the design.
    await expect(page.getByText(/Jobs ·/)).toBeVisible();
    await expect(
      page.getByText('Payloads are PII-redacted. Retry is the only action — destructive job operations are disabled in this console.'),
    ).toBeVisible();
  });
});

// =============================================================================
// Surface 16 — Prisma Studio
// =============================================================================
test.describe('TASK-403 — Prisma Studio surface', () => {
  test('status card reports Disabled in the fail-closed test environment', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/prisma-studio');
    await expect(page.getByRole('heading', { name: 'Prisma Studio', exact: true })).toBeVisible();

    const card = page.getByTestId('pstudio-status-card');
    await expect(card.getByText('Disabled', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('off in this environment')).toBeVisible();

    // No link-out affordance when the shell is disabled.
    await expect(page.getByRole('button', { name: 'Open Prisma Studio' })).toHaveCount(0);
  });
});
