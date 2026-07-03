/**
 * TASK-401 — user impersonation (T5 "act-as"): FE lifecycle E2E.
 *
 * Proves the full admin-app impersonation loop against the live stack:
 *   - super-admin starts an impersonation from the user detail "More actions"
 *     menu (confirm dialog with audited optional reason);
 *   - the indigo `--ai` banner renders ("Viewing as {name} — ends in
 *     {countdown} · Exit"), the countdown ticks, and the banner persists
 *     across navigation — including a hard reload (sessionStorage rehydrate);
 *   - the session REALLY swaps: TASK-394's route guards re-evaluate, so the
 *     impersonated doctor is bounced off `/dashboard` while data surfaces
 *     (Consultation History) render for the doctor;
 *   - Exit restores the original super-admin session, lands back on the
 *     target's detail page (returnTo), and the guarded surface opens again;
 *   - the affordance is super-admin-only: tenant-admin sees NO "Impersonate"
 *     item on either the detail menu or the grid row menu.
 *
 * NON-DESTRUCTIVE: minting/revoking an impersonation token mutates no data —
 * it only appends audit rows (the API contract around claims/expiry/safeguards
 * is covered by `apps/api/tests/e2e/task-401-impersonation.spec.ts`).
 *
 * Personas/ids mirror `tests/helpers` SEEDED_USERS. The seeded doctor's role
 * assignment lives on the system "Global" tenant, so its detail page sits
 * under that tenant's users surface.
 */
import { test, expect, type Page } from './fixtures/auth';

const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const DOCTOR_ID = '70000000-0000-0000-0000-000000000010';
const DOCTOR_DETAIL = `/tenants/${GLOBAL_TENANT_ID}/users/${DOCTOR_ID}`;
const USERS_GRID = `/tenants/${GLOBAL_TENANT_ID}/users`;

const MOBILE_MAX = 768; // TASK-384: `< md` is the mobile card-list tier.

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < MOBILE_MAX;
}

/** Open the doctor's detail page and wait for its action header. */
async function openDoctorDetail(page: Page): Promise<void> {
  await page.goto(DOCTOR_DETAIL);
  await expect(page.getByRole('button', { name: 'More actions' })).toBeVisible({ timeout: 15_000 });
}

test.describe('TASK-401 — impersonation lifecycle (super-admin)', () => {
  test('start → banner + guards re-evaluate → exit restores the original session', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openDoctorDetail(page);

    // --- start from the detail "More actions" menu ---
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Impersonate' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Impersonate user' })).toBeVisible();
    await dialog.locator('#imp-reason').fill('TASK-401 FE E2E lifecycle');
    await page.getByTestId('impersonate-confirm').click();

    // --- impersonated session: banner + doctor-visible surface ---
    await page.waitForURL('**/history', { timeout: 15_000 });
    const banner = page.getByTestId('impersonation-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Viewing as doctor');
    await expect(page.getByTestId('impersonation-countdown')).toHaveText(/\d+:\d{2}/);
    // Data renders as the doctor (History is a doctor-visible surface).
    await expect(page.getByRole('heading', { name: 'Consultation History' })).toBeVisible({ timeout: 15_000 });

    // Countdown ticks (time-boxed session is live).
    const before = await page.getByTestId('impersonation-countdown').textContent();
    await expect.poll(async () => page.getByTestId('impersonation-countdown').textContent(), { timeout: 5_000 }).not.toBe(before);

    // --- guards re-evaluate: the doctor is bounced off a super-admin surface.
    // `goto` is a hard load, so this also proves the impersonated session
    // (incl. the banner) survives a sessionStorage rehydrate.
    await page.goto('/dashboard');
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).not.toBe('/dashboard');
    await expect(page.getByRole('heading', { name: 'Platform Dashboard' })).toHaveCount(0);
    await expect(page.getByTestId('impersonation-banner')).toBeVisible();

    // --- exit restores the original super-admin session + returnTo ---
    await page.getByTestId('impersonation-exit').click();
    await page.waitForURL(`**${DOCTOR_DETAIL}`, { timeout: 15_000 });
    await expect(page.getByTestId('impersonation-banner')).toHaveCount(0);

    // Super-admin powers are back: the guarded surface opens again.
    await page.goto('/dashboard');
    await page.waitForURL('**/dashboard', { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Platform Dashboard' })).toBeVisible();
  });

  test('users grid row menu exposes Impersonate for an enabled non-self user', async ({ page, loginAs }) => {
    test.skip(isMobile(page), 'Mobile card list has no row action menu (TASK-384 model).');

    await loginAs('superAdmin');
    await page.goto(USERS_GRID);
    await page.getByLabel('Search').first().fill('doctor');

    // aria-label is exact per row ("Actions for doctor"), so doctor2 can't collide.
    await page.getByRole('button', { name: 'Actions for doctor', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Impersonate' })).toBeVisible();
    await page.keyboard.press('Escape');
  });
});

test.describe('TASK-401 — super-admin-only affordance', () => {
  test('tenant-admin sees NO Impersonate action (detail + grid)', async ({ page, loginAs }) => {
    await loginAs('tenantAdmin');

    await openDoctorDetail(page);
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Impersonate' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    if (!isMobile(page)) {
      await page.goto(USERS_GRID);
      await page.getByLabel('Search').first().fill('doctor');
      await page.getByRole('button', { name: 'Actions for doctor', exact: true }).click();
      await expect(page.getByRole('menuitem', { name: 'View' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Impersonate' })).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
  });
});
