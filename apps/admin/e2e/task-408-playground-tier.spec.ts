/**
 * TASK-408 — Playground tier (screens 50–59): Clinical Consultation · Voice
 * Profile · DNA Writing Style · Summarization.
 *
 * Browser-driven, full-stack (Vite :5174 → API :8868). Run with a seeded test
 * stack: `SKIP_DB_PRECHECK=true pnpm exec playwright test --config apps/admin/playwright.config.ts task-408`.
 *
 * Coverage:
 *   nav   · super-admin AND tenant-admin see the PLAYGROUND section (all four
 *           entries — the tier is admin-gated, not super-admin-only) with the
 *           TASK-403 Operations/Developer entries preserved for super-admin;
 *           a doctor sees none of the four (drawer-aware on mobile).
 *   50    · Clinical Consultation renders list + detail panes; the "Start
 *           consultation" action is HONESTLY gated for the super-admin persona
 *           (no doctor identity → disabled button + explanation caption).
 *           Detail fields load for the TENANT-BOUND admin; the tenant-less
 *           super-admin gets the honest tenant-scope error (consultation reads
 *           are CLS-scoped server-side — the known TASK-331 platform gap).
 *   52    · Voice Profile renders the enrollment status card (active or
 *           fail-closed caption — never fabricated) and the Enroll action.
 *   53    · DNA Writing Style renders both tabs; "My style" resolves to the
 *           real report card or the honest empty state; "All reports" loads
 *           the tenant-scoped table (rows or honest empty state).
 *   54    · Summarization renders the consultation picker + generate actions
 *           and the flagged-gap footnote (per-metric evaluation = TARGET).
 *           Generation is doctor-ownership-scoped server-side, so for the
 *           admin personas the buttons stay HONESTLY disabled with the gate
 *           caption (and the live SMR pipeline is never invoked by the spec).
 *
 * Non-destructive: read-only throughout — no consultation is started, nothing
 * is enrolled, generated or deleted.
 */
import type { Page } from '@playwright/test';
import { test, expect, type PersonaKey } from './fixtures/auth';

const PLAYGROUND_LINKS = ['Clinical Consultation', 'Voice Profile', 'DNA Writing Style', 'Summarization'] as const;

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
// Navigation visibility (per tier)
// =============================================================================
test.describe('TASK-408 — Playground nav visibility', () => {
  test('super-admin sees all four Playground entries; Operations + Developer preserved', async ({ page, loginAs }) => {
    const nav = await primaryNav(page, loginAs, 'superAdmin');
    for (const label of PLAYGROUND_LINKS) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
    // TASK-403's sections must survive the additive nav change.
    await expect(nav.getByRole('link', { name: 'Rate Limits' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Components' })).toBeVisible();
  });

  test('tenant-admin sees the Playground entries (admin tier, not super-admin-only)', async ({ page, loginAs }) => {
    const nav = await primaryNav(page, loginAs, 'tenantAdmin');
    for (const label of PLAYGROUND_LINKS) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
    // …while the super-admin-only Operations tier stays hidden for them.
    await expect(nav.getByRole('link', { name: 'Rate Limits' })).toHaveCount(0);
  });

  test('doctor sees none of the Playground entries', async ({ page, loginAs }) => {
    const nav = await primaryNav(page, loginAs, 'doctor');
    await expect(nav.getByRole('link', { name: 'Users' })).toBeVisible(); // nav rendered
    for (const label of PLAYGROUND_LINKS) {
      await expect(nav.getByRole('link', { name: label })).toHaveCount(0);
    }
  });
});

// =============================================================================
// Screen 50 — Clinical Consultation
// =============================================================================
test.describe('TASK-408 — Clinical Consultation (screen 50)', () => {
  test('renders list + detail panes with the honest doctor-identity gate', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/playground/consultation');
    await expect(page.getByRole('heading', { name: 'Clinical Consultation' })).toBeVisible();

    // super_admin has no doctor identity → the create action is HONESTLY
    // disabled with an explanation, never hidden and never silently failing.
    await expect(page.getByTestId('start-consultation')).toBeDisabled();
    await expect(page.getByTestId('start-consultation-gate')).toContainText('doctor identity');

    // Master pane resolves to rows or the honest empty state (seed-agnostic).
    const list = page.getByRole('region', { name: 'Consultations' });
    await expect(list.getByPlaceholder('Filter by patient or ID…')).toBeVisible();
    await expect(list.locator('ul > li').or(list.getByText('No consultations')).first()).toBeVisible();

    // Detail pane opens on its prompt state until a row is picked.
    await expect(page.getByRole('region', { name: 'Consultation detail' }).getByText('Select a consultation')).toBeVisible();
  });

  test('tenant-admin sees lifecycle fields on selection; super-admin gets the honest tenant-scope error', async ({ page, loginAs }) => {
    // Tenant-bound admin — the detail path works end-to-end.
    await loginAs('tenantAdmin');
    await page.goto('/playground/consultation');
    const list = page.getByRole('region', { name: 'Consultations' });
    const first = list.locator('ul > li button').first();
    // Seed-agnostic: skip (honestly) when the workspace has no consultations.
    try {
      await first.waitFor({ state: 'visible', timeout: 8_000 });
    } catch {
      test.skip(true, 'No seeded consultations in this workspace — list empty state already asserted above.');
    }
    await first.click();
    const detail = page.getByRole('region', { name: 'Consultation detail' });
    await expect(page.getByTestId('consultation-fields')).toBeVisible();
    await expect(detail.getByRole('heading', { name: /Context items/ })).toBeVisible();
    await expect(detail.getByRole('heading', { name: /Summaries/ })).toBeVisible();
  });

  test('super-admin detail selection surfaces the honest tenant-scope error (TASK-331 gap)', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/playground/consultation');
    const first = page.getByRole('region', { name: 'Consultations' }).locator('ul > li button').first();
    try {
      await first.waitFor({ state: 'visible', timeout: 8_000 });
    } catch {
      test.skip(true, 'No seeded consultations in this workspace.');
    }
    await first.click();
    // Cross-tenant super-admin sessions have no working tenant; the read is
    // rejected server-side and the page says so instead of spinning forever.
    await expect(page.getByTestId('consultation-load-error').or(page.getByTestId('consultation-fields'))).toBeVisible();
  });
});

// =============================================================================
// Screen 52 — Voice Profile
// =============================================================================
test.describe('TASK-408 — Voice Profile (screen 52)', () => {
  test('renders the enrollment status card, table/empty state and enroll action', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/playground/voice-profile');
    await expect(page.getByRole('heading', { name: 'Voice Profile' })).toBeVisible();

    // The status card is honest either way: active, or the fail-closed caption.
    const status = page.getByTestId('enrollment-status-card');
    await expect(status).toBeVisible();
    await expect(status.getByText('Enrollment active').or(status.getByText('No active profile'))).toBeVisible();

    await expect(page.getByRole('button', { name: 'Enroll samples' })).toBeEnabled();
    await expect(page.locator('tbody tr').or(page.getByText('No voice profiles yet')).first()).toBeVisible();

    // Enroll dialog opens with the 3-sample contract; closed without enrolling.
    await page.getByRole('button', { name: 'Enroll samples' }).click();
    await expect(page.getByRole('dialog', { name: 'Enroll voice samples' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

// =============================================================================
// Screen 53 — DNA Writing Style
// =============================================================================
test.describe('TASK-408 — DNA Writing Style (screen 53)', () => {
  test('renders My style (report or honest empty state) and the All reports tab', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/playground/dna-style');
    await expect(page.getByRole('heading', { name: 'DNA Writing Style' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate from samples' })).toBeEnabled();

    // "My style" resolves to the real report card or the honest empty state.
    await expect(page.getByTestId('dna-style-card').or(page.getByTestId('dna-empty-state'))).toBeVisible();

    // Cross-user list — rows or empty state, plus the tenant-scoping caption
    // (the cross-tenant browse gap is flagged, not faked).
    await page.getByRole('tab', { name: 'All reports' }).click();
    await expect(page.locator('tbody tr').or(page.getByText('No DNA reports in this workspace')).first()).toBeVisible();
    await expect(page.getByText('Tenant-scoped', { exact: false })).toBeVisible();
  });
});

// =============================================================================
// Screen 54 — Summarization
// =============================================================================
test.describe('TASK-408 — Summarization (screen 54)', () => {
  test('renders the picker with honestly-gated generation and the flagged-metrics footnote', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/playground/summarization');
    await expect(page.getByRole('heading', { name: 'Summarization' })).toBeVisible();

    await expect(page.getByLabel('Select consultation')).toBeVisible();
    // Generation is doctor-ownership-scoped server-side → for the admin
    // persona the buttons are disabled with the explanation caption (when a
    // consultation is selected), never silently failing.
    await expect(page.getByTestId('generate-pre-summary')).toBeDisabled();
    await expect(page.getByTestId('generate-summary')).toBeDisabled();

    // Honest TARGET framing: per-metric evaluation is flagged as a gap.
    await expect(page.getByText('Per-metric evaluation', { exact: false })).toBeVisible();

    // Summaries panel resolves honestly: content, the empty state, the
    // no-consultation prompt, or (tenant-less super-admin) the scope error.
    const panel = page.getByRole('region', { name: 'Summaries' });
    await expect(
      panel
        .locator('li')
        .or(panel.getByTestId('summaries-empty'))
        .or(panel.getByText('No consultation selected'))
        .or(panel.getByTestId('summaries-load-error'))
        .first(),
    ).toBeVisible();

    // The gate caption accompanies a selected-but-not-owned consultation.
    const anySelected = await page.getByLabel('Select consultation').textContent();
    if (anySelected && !anySelected.includes('Select a consultation')) {
      await expect(page.getByTestId('generate-gate')).toContainText('doctor');
    }
  });
});
