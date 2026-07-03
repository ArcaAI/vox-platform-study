/**
 * Admin E2E — shared auth fixture.
 *
 * Logs in through the real login UI (`/login`) using the seeded personas, so
 * every spec gets a faithful frontend→backend session (the SDK wires its own
 * bearer/tenant headers on a successful `useAuth().login`). Personas + the
 * `password123` default mirror `tests/helpers` SEEDED_USERS and the manual QA
 * suite (`docs/qa/manual-tests/README.md` §5).
 *
 * Usage:
 *   import { test, expect, type PersonaKey } from './fixtures/auth';
 *   test('...', async ({ page, loginAs }) => {
 *     await loginAs('superAdmin');
 *     await page.goto('/tenants');
 *   });
 */
import { test as base, expect, type Page } from '@playwright/test';

export type PersonaKey = 'superAdmin' | 'tenantAdmin' | 'arcaaiAdmin' | 'doctor';

export interface Persona {
  username: string;
  password: string;
  /** Workspace key; omitted for the cross-tenant super-admin. */
  tenantKey?: string;
}

/** Seeded accounts (non-production). Source: docs/qa/manual-tests/README.md §5. */
export const PERSONAS: Record<PersonaKey, Persona> = {
  superAdmin: { username: 'super_admin', password: 'password123' },
  tenantAdmin: { username: 'tenant_admin', password: 'password123', tenantKey: '__GLOBAL__' },
  arcaaiAdmin: { username: 'arcaai_admin', password: 'password123', tenantKey: 'ARCAAI' },
  // Non-super-admin logins REQUIRE a workspace key (mirrors tests/helpers,
  // which always logs the doctor in with DEFAULT_TENANT_KEY) — TASK-403.
  doctor: { username: 'doctor', password: 'password123', tenantKey: '__GLOBAL__' },
};

/** Drive the real login form and wait for the post-login landing (`/tenants`). */
export async function loginAs(page: Page, persona: PersonaKey): Promise<void> {
  const p = PERSONAS[persona];
  await page.goto('/login');
  await page.locator('#username').fill(p.username);
  await page.locator('#password').fill(p.password);
  if (p.tenantKey) await page.locator('#tenantKey').fill(p.tenantKey);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/tenants', { timeout: 15_000 });
}

interface AuthFixtures {
  loginAs: (persona: PersonaKey) => Promise<void>;
}

export const test = base.extend<AuthFixtures>({
  loginAs: async ({ page }, use) => {
    await use((persona: PersonaKey) => loginAs(page, persona));
  },
});

export { expect };
